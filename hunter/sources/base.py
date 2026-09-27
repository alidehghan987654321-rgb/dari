"""The two kinds of source a hunt needs, and helpers for reading messy API fields."""

from __future__ import annotations

import re
from typing import Any, Protocol

from ..categories import Category
from ..models import MarketListing, SupplierOffer


class MarketSource(Protocol):
    name: str

    def trending(self, category: Category, limit: int) -> list[MarketListing]:
        """Best-selling products in a category."""
        ...


class SupplierSource(Protocol):
    def by_image(self, image_url: str, limit: int) -> list[SupplierOffer]:
        """1688 offers that look like the product in the picture."""
        ...

    def by_keyword(self, query: str, limit: int) -> list[SupplierOffer]: ...


def pick(item: dict[str, Any], *keys: str) -> Any:
    """First present, non-empty value among ``keys``; dotted keys reach into dicts and
    lists ("images.0")."""
    for key in keys:
        value: Any = item
        for part in key.split("."):
            if isinstance(value, dict):
                value = value.get(part)
            elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
                value = value[int(part)]
            else:
                value = None
        if value not in (None, "", [], {}):
            return value
    return None


_NUMBER = re.compile(r"\d+(?:[.,]\d+)*(?:\.\d+)?")


def to_number(value: Any, *, highest: bool = False) -> float | None:
    """12.5, "¥12.50", "$9.99", "12.5-15" (a range: lowest, or highest if asked)."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        return to_number(pick(value, "value", "amount", "price", "min", "max"), highest=highest)
    if isinstance(value, list):
        nums = [n for n in (to_number(v) for v in value) if n is not None]
        return (max if highest else min)(nums) if nums else None
    nums = [float(n.replace(",", "")) for n in _NUMBER.findall(str(value))]
    if not nums:
        return None
    return max(nums) if highest else min(nums)


def to_count(value: Any) -> int | None:
    """Sold/review counts: 1234, "1,234", "10K+ sold", "2.5万+", "1.2k"."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).lower().replace(",", "")
    m = re.search(r"(\d+(?:\.\d+)?)\s*([km万千]?)", text)
    if not m:
        return None
    n = float(m.group(1))
    n *= {"k": 1_000, "千": 1_000, "m": 1_000_000, "万": 10_000}.get(m.group(2), 1)
    return int(n)
