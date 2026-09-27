"""The hunt: trending listings -> matching 1688 offer -> pricing -> score, per category."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .categories import Category, classify, hunt_categories, pack_qty
from .models import Candidate, MarketListing, SupplierOffer
from .pricing import PricingConfig, Unprofitable, price_product
from .scoring import assess
from .sources import MarketSource, SupplierSource

log = logging.getLogger(__name__)


def pick_offer(offers: list[SupplierOffer], max_moq: int) -> SupplierOffer | None:
    """The cheapest offer worth trusting.

    Offers far below the others are usually a different (smaller, flimsier) item, and
    offers with almost no sales are a gamble, so those only win when nothing else is left.
    """
    usable = [o for o in offers if o.price_cny > 0 and o.moq <= max_moq]
    if not usable:
        return None
    prices = sorted(o.price_cny for o in usable)
    median = prices[len(prices) // 2]
    sane = [o for o in usable if o.price_cny >= 0.35 * median]
    proven = [o for o in sane if (o.sales or 0) >= 50] or sane
    return min(proven, key=lambda o: o.price_cny)


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
    ):
        self.markets = markets
        self.supplier = supplier
        self.cfg = cfg or PricingConfig()

    def hunt(
        self, categories: Iterable[Category] | None = None, per_category: int = 20
    ) -> HuntResult:
        started = datetime.now(timezone.utc).isoformat(timespec="seconds")
        skipped: dict[str, int] = {}
        best: dict[str, Candidate] = {}  # by 1688 offer: two listings can find the same one

        for category in categories or hunt_categories():
            for market in self.markets:
                try:
                    listings = market.trending(category, per_category)
                except Exception:
                    log.exception("%s: couldn't list %s", market.name, category.key)
                    skipped["market_error"] = skipped.get("market_error", 0) + 1
                    continue
                for listing in listings:
                    listing.category = listing.category or category.key
                    candidate = self.evaluate(listing, category, skipped)
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

    def evaluate(
        self, listing: MarketListing, category: Category, skipped: dict[str, int]
    ) -> Candidate | None:
        def skip(reason: str) -> None:
            skipped[reason] = skipped.get(reason, 0) + 1

        try:
            offers = self.supplier.by_image(listing.image_url, 10)
            if not offers:
                offers = self.supplier.by_keyword(f"{category.zh_query} {listing.title[:40]}", 10)
        except Exception:
            log.exception("1688 search failed for %s", listing.url)
            skip("supplier_error")
            return None
        offer = pick_offer(offers, self.cfg.max_moq)
        if offer is None:
            skip("no_supplier")
            return None

        # "2 Pack" on Temu against a single piece on 1688 means buying two.
        units = max(1, round(pack_qty(listing.title) / pack_qty(offer.title)))
        weight = listing.weight_kg or (
            offer.weight_kg * units if offer.weight_kg else category.default_weight_kg * units
        )

        if listing.source == "temu":
            benchmark, estimated = listing.price_usd, False
        else:
            benchmark, estimated = listing.price_usd * self.cfg.temu_vs_amazon, True
        try:
            pricing = price_product(
                offer.price_cny,
                weight,
                benchmark,
                self.cfg,
                benchmark_estimated=estimated,
                units=units,
            )
        except Unprofitable:
            skip("unprofitable_settings")
            return None

        a = assess(listing, offer, pricing, weight, self.cfg.max_premium)
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
            title_fa=listing.title_fa,
            starter_qty=starter_qty,
            starter_capital_usd=round(starter_qty * pricing.landed_usd, 2),
        )
