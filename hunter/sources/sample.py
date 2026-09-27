"""Bundled sample data, so the hunter runs (and can be shown) without any API key.

The numbers are illustrative: they are in the right range for these products but are
not current prices, and the suppliers are made up. Their links open a real search for
the item on Temu and 1688. Image search is simulated: each sample listing's picture
maps to a few 1688 offers.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from urllib.parse import urlsplit

from ..categories import Category
from ..models import MarketListing, SupplierOffer

SAMPLE_FILE = Path(__file__).resolve().parent.parent / "data" / "sample.json"


class SampleData:
    name = "sample"

    def __init__(self, path: Path = SAMPLE_FILE):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.note: str = data.get("note", "")
        names = data.get("names_fa", {})
        self.listings = [
            MarketListing(**x, title_fa=names.get(x["id"], "")) for x in data["listings"]
        ]
        # The same products on Amazon, keyed by the Temu listing's id.
        self.amazon = {
            key: MarketListing(**x, source="amazon", category="", title_fa=names.get(key, ""))
            for key, x in data.get("amazon_matches", {}).items()
        }
        self.offers = {
            image: [SupplierOffer(**o) for o in offers]
            for image, offers in data["offers_by_image"].items()
        }

    def trending(self, category: Category, limit: int) -> list[MarketListing]:
        found = [x for x in self.listings if x.category == category.key]
        return sorted(found, key=lambda x: -(x.monthly_sold or 0))[:limit]

    def find_similar(self, listing: MarketListing) -> MarketListing | None:
        if listing.source == "temu":
            found = self.amazon.get(listing.id)
        else:
            key = next((k for k, x in self.amazon.items() if x.url == listing.url), None)
            found = next((x for x in self.listings if x.id == key), None)
        return replace(found) if found else None

    def _all(self) -> list[MarketListing]:
        return [*self.listings, *self.amazon.values()]

    def handles(self, url: str) -> bool:
        host = urlsplit(url).hostname or ""
        return host.endswith("temu.com") or ".amazon." in f".{host}"

    def listing_by_url(self, url: str) -> MarketListing | None:
        found = next((x for x in self._all() if x.url == url.strip()), None)
        return replace(found) if found else None

    def by_images(self, image_urls: list[str], limit: int) -> dict[str, list[SupplierOffer]]:
        return {u: self.offers[u][:limit] for u in image_urls if u in self.offers}

    def by_image(self, image_url: str, limit: int) -> list[SupplierOffer]:
        return self.offers.get(image_url, [])[:limit]

    def by_keyword(self, query: str, limit: int) -> list[SupplierOffer]:
        return []
