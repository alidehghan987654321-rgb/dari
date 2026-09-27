"""Bundled sample data, so the hunter runs (and can be shown) without any API key.

The numbers are illustrative: they are in the right range for these products but are
not current prices. Image search is simulated: each sample listing's picture maps to a
few 1688 offers.
"""

from __future__ import annotations

import json
from pathlib import Path

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
        self.offers = {
            image: [SupplierOffer(**o) for o in offers]
            for image, offers in data["offers_by_image"].items()
        }

    def trending(self, category: Category, limit: int) -> list[MarketListing]:
        found = [x for x in self.listings if x.category == category.key]
        return sorted(found, key=lambda x: -(x.monthly_sold or 0))[:limit]

    def by_image(self, image_url: str, limit: int) -> list[SupplierOffer]:
        return self.offers.get(image_url, [])[:limit]

    def by_keyword(self, query: str, limit: int) -> list[SupplierOffer]:
        return []
