"""Amazon best sellers through the Keepa API (https://keepa.com/#!api).

Two calls per category: ``/bestsellers`` for the ranked ASINs (costs ~50 tokens), then
``/product`` with 30-day stats for the top ones (~1 token each). Prices come in cents,
the rating as 0-50, weights in grams; -1 means "no data".
"""

from __future__ import annotations

import logging

import httpx

from ..categories import Category
from ..models import MarketListing

log = logging.getLogger(__name__)

API = "https://api.keepa.com"
IMAGE_BASE = "https://m.media-amazon.com/images/I/"

# Indexes into stats.current (Keepa's csv types).
AMAZON, NEW, RATING, COUNT_REVIEWS, BUY_BOX_SHIPPING = 0, 1, 16, 17, 18


class Keepa:
    name = "amazon"

    def __init__(self, key: str, domain: int = 1, client: httpx.Client | None = None):
        self.key = key
        self.domain = domain  # 1 = amazon.com
        self.http = client or httpx.Client(timeout=120)

    def _get(self, endpoint: str, **params) -> dict:
        r = self.http.get(
            f"{API}/{endpoint}", params={"key": self.key, "domain": self.domain, **params}
        )
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"Keepa {endpoint}: {data['error']}")
        return data

    def trending(self, category: Category, limit: int) -> list[MarketListing]:
        best = self._get("bestsellers", category=category.amazon_category_id)
        asins = (best.get("bestSellersList") or {}).get("asinList") or []
        if not asins:
            return []
        # Ask for extra: some best sellers have no price right now.
        wanted = asins[: limit * 2]
        products = self._get("product", asin=",".join(wanted), stats=30).get("products") or []
        listings = [x for x in (to_listing(p, category.key) for p in products) if x]
        return listings[:limit]


def _current(stats: dict, index: int) -> int | None:
    current = stats.get("current") or []
    if index < len(current) and current[index] is not None and current[index] >= 0:
        return current[index]
    return None


def image_url(product: dict) -> str:
    images = product.get("images") or []
    for img in images:
        if img and (img.get("l") or img.get("m")):
            return IMAGE_BASE + (img.get("l") or img.get("m"))
    csv = product.get("imagesCSV") or ""
    first = csv.split(",")[0].strip()
    return IMAGE_BASE + first if first else ""


def to_listing(product: dict, category: str) -> MarketListing | None:
    stats = product.get("stats") or {}
    cents = next(
        (c for c in (_current(stats, i) for i in (BUY_BOX_SHIPPING, NEW, AMAZON)) if c),
        None,
    )
    asin = product.get("asin")
    if not asin or not cents:
        return None
    rating = _current(stats, RATING)
    grams = next(
        (g for g in (product.get("packageWeight"), product.get("itemWeight")) if g and g > 0), None
    )
    return MarketListing(
        source="amazon",
        id=asin,
        title=product.get("title") or "",
        url=f"https://www.amazon.com/dp/{asin}",
        image_url=image_url(product),
        price_usd=cents / 100,
        category=category,
        monthly_sold=product.get("monthlySold") or None,
        reviews=_current(stats, COUNT_REVIEWS),
        rating=rating / 10 if rating is not None else None,
        weight_kg=grams / 1000 if grams else None,
    )
