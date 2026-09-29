"""The hunt: trending listings -> matching 1688 offer -> pricing -> score, per category."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .categories import Category, classify, find_category, hunt_categories, pack_qty
from .models import Candidate, MarketListing, SupplierOffer
from .pricing import PricingConfig, Unprofitable, price_product
from .scoring import assess, supplier_level
from .sources import MarketSource, SupplierSource
from .sources.base import LinkError

log = logging.getLogger(__name__)


def rank_offers(offers: list[SupplierOffer], max_moq: int) -> list[SupplierOffer]:
    """The offers worth trusting, best first.

    Offers far below the others are usually a different (smaller, flimsier) item, and
    offers with almost no sales are a gamble, so those only come first when nothing else
    is left. Among the rest the price decides, with a factory or a long-standing shop
    worth paying a few percent more for.
    """
    usable = [o for o in offers if o.price_cny > 0 and o.moq <= max_moq]
    if not usable:
        return []
    prices = sorted(o.price_cny for o in usable)
    median = prices[len(prices) // 2]
    sane = [o for o in usable if o.price_cny >= 0.35 * median]

    def key(o: SupplierOffer) -> tuple[bool, float]:
        trust = (0.05 if o.is_factory else 0) + min(o.years or 0, 10) * 0.005
        return ((o.sales or 0) < 50, o.price_cny * (1 - trust))

    return sorted(sane, key=key)


def pick_offer(offers: list[SupplierOffer], max_moq: int) -> SupplierOffer | None:
    ranked = rank_offers(offers, max_moq)
    return ranked[0] if ranked else None


@dataclass
class HuntResult:
    candidates: list[Candidate]
    started_at: str
    sources: list[str]
    sample: bool = False
    note: str = ""
    skipped: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "started_at": self.started_at,
            "sources": self.sources,
            "sample": self.sample,
            "note": self.note,
            "skipped": self.skipped,
            "candidates": [c.to_dict() for c in self.candidates],
        }


class Hunter:
    def __init__(
        self,
        markets: list[MarketSource],
        supplier: SupplierSource,
        cfg: PricingConfig | None = None,
        *,
        results: int = 6,
        known: Callable[[MarketListing], dict | None] | None = None,
        reuse_days: float = 7,
    ):
        self.markets = markets
        self.supplier = supplier
        self.cfg = cfg or PricingConfig()
        # 1688 offers asked for in each search; every result is paid for, and the best one
        # and two backups come from the first few.
        self.results = results
        # A listing's earlier find (a Candidate dict), if there is one: a product that stays
        # a bestseller for days isn't searched on 1688 or matched again until its search is
        # reuse_days old; it's only priced afresh.
        self.known = known
        self.reuse_days = reuse_days

    def hunt(
        self, categories: Iterable[Category] | None = None, per_category: int = 20
    ) -> HuntResult:
        started = datetime.now(timezone.utc).isoformat(timespec="seconds")
        skipped: dict[str, int] = {}
        best: dict[str, Candidate] = {}  # by 1688 offer: two listings can find the same one

        for category in categories or hunt_categories():
            listings: list[MarketListing] = []
            for market in self.markets:
                try:
                    listings += market.trending(category, per_category)
                except Exception:
                    log.exception("%s: couldn't list %s", market.name, category.key)
                    skipped["market_error"] = skipped.get("market_error", 0) + 1
            earlier = {x.id: e for x in listings if (e := self.recent(x))}
            # One 1688 image search for the whole category instead of one per product, and
            # only for the products not searched lately.
            offers = self.prefetch_offers(
                [x.image_url for x in listings if x.image_url and x.id not in earlier]
            )
            for listing in listings:
                listing.category = listing.category or category.key
                candidate = self.evaluate(
                    listing,
                    category,
                    skipped,
                    offers.get(listing.image_url),
                    earlier.get(listing.id),
                )
                if candidate:
                    kept = best.get(candidate.offer.id)
                    if kept is None or candidate.score > kept.score:
                        best[candidate.offer.id] = candidate

        ranked = sorted(
            best.values(),
            key=lambda c: ({"green": 0, "yellow": 1, "red": 2}[c.verdict], -c.score),
        )
        return HuntResult(
            candidates=ranked,
            started_at=started,
            sources=[m.name for m in self.markets],
            skipped=skipped,
        )

    def recent(self, listing: MarketListing) -> dict | None:
        """This listing's earlier find, if its 1688 search is younger than reuse_days."""
        found = self.known(listing) if self.known else None
        when = (found or {}).get("searched_at")
        if not when:
            return None
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(when)
        except ValueError:
            return None
        return found if age < timedelta(days=self.reuse_days) else None

    def prefetch_offers(self, image_urls: list[str]) -> dict[str, list[SupplierOffer]]:
        """1688 offers for many pictures in one search, where the source can do that."""
        if not image_urls or not hasattr(self.supplier, "by_images"):
            return {}
        try:
            return self.supplier.by_images(list(dict.fromkeys(image_urls)), self.results)
        except Exception:
            log.exception("Batched 1688 search failed; searching one by one")
            return {}

    def evaluate(
        self,
        listing: MarketListing,
        category: Category,
        skipped: dict[str, int],
        offers: list[SupplierOffer] | None = None,
        earlier: dict | None = None,
    ) -> Candidate | None:
        def skip(reason: str) -> None:
            skipped[reason] = skipped.get(reason, 0) + 1

        searched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if earlier:  # searched lately: the same offers and matches, priced with today's prices
            offers = [
                SupplierOffer(**o) for o in [earlier["offer"], *earlier.get("alternatives", [])]
            ]
            searched_at = earlier["searched_at"]
        try:
            if offers is None:
                offers = self.supplier.by_image(listing.image_url, self.results)
            if not offers:
                offers = self.supplier.by_keyword(
                    f"{category.zh_query} {listing.title[:40]}", self.results
                )
        except Exception:
            log.exception("1688 search failed for %s", listing.url)
            skip("supplier_error")
            return None
        ranked = rank_offers(offers, self.cfg.max_moq)
        if not ranked:
            skip("no_supplier")
            return None
        offer = ranked[0]

        # "2 Pack" on Temu against a single piece on 1688 means buying two.
        units = max(1, round(pack_qty(listing.title) / pack_qty(offer.title)))
        weight = listing.weight_kg or (
            offer.weight_kg * units if offer.weight_kg else category.default_weight_kg * units
        )

        if earlier:
            matches = [MarketListing(**m) for m in earlier.get("matches", [])]
        else:
            matches = self.find_matches(listing)
        on = {x.source: x for x in [listing, *matches]}
        temu, amazon = on.get("temu"), on.get("amazon")
        if temu:
            benchmark, estimated = temu.price_usd, False
        else:
            benchmark, estimated = listing.price_usd * self.cfg.temu_vs_amazon, True
        try:
            pricing = price_product(
                offer.price_cny,
                weight,
                benchmark or None,
                self.cfg,
                benchmark_estimated=estimated,
                units=units,
                amazon_usd=amazon.price_usd if amazon else None,
            )
        except Unprofitable:
            skip("unprofitable_settings")
            return None

        a = assess(listing, offer, pricing, weight, self.cfg.max_premium, matches)
        if units > 1:
            a.flags.append(
                f"قیمت 1688 برای {units} عدد حساب شد (آگهی بسته‌ی {units}تاییه)؛ "
                "تعداد هر بسته رو با تأمین‌کننده چک کن"
            )
        starter_qty = max(offer.moq, self.cfg.min_starter_qty)
        return Candidate(
            id=f"{listing.source}:{listing.id}",
            category=classify(f"{listing.title} {offer.title}", category.key),
            listing=listing,
            offer=offer,
            pack_qty=units,
            weight_kg=round(weight, 3),
            pricing=pricing,
            score=a.score,
            verdict=a.verdict,
            pros=a.pros,
            cons=a.cons,
            flags=a.flags,
            title_fa=listing.title_fa or next((m.title_fa for m in matches if m.title_fa), ""),
            starter_qty=starter_qty,
            starter_capital_usd=round(starter_qty * pricing.landed_usd, 2),
            alternatives=ranked[1:3],
            matches=matches,
            searched_at=searched_at,
            level=supplier_level(offer),
        )

    def find_matches(self, listing: MarketListing) -> list[MarketListing]:
        """The same product on the other marketplaces (Amazon for a Temu find, and back)."""
        found = []
        for market in self.markets:
            if market.name == listing.source or not hasattr(market, "find_similar"):
                continue
            try:
                match = market.find_similar(listing)
            except Exception:
                log.exception("%s: couldn't look for %s", market.name, listing.url)
                continue
            if match and match.source != listing.source:
                match.category = listing.category
                found.append(match)
        return found

    def analyze_url(self, url: str) -> Candidate:
        """Full analysis of one Temu or Amazon product link a seller brought."""
        market = next(
            (m for m in self.markets if getattr(m, "handles", None) and m.handles(url)), None
        )
        if market is None:
            raise LinkError("unsupported_link")
        try:
            listing = market.listing_by_url(url)
        except LinkError:
            raise
        except Exception:
            log.exception("%s: couldn't read %s", market.name, url)
            raise LinkError("listing_error") from None
        if listing is None:
            raise LinkError("listing_not_found")
        category = find_category(classify(listing.title, listing.category))
        listing.category = category.key
        skipped: dict[str, int] = {}
        candidate = self.evaluate(listing, category, skipped)
        if candidate is None:
            raise LinkError(next(iter(skipped), "no_supplier"))
        return candidate
