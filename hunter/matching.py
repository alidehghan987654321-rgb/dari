"""Finding the same product on another marketplace by its title.

Amazon has no image search, so a Temu product is looked up there by keywords, and the
closest title wins. Titles differ in length (Amazon's pile on features), so closeness is
the share of the shorter title's words that the other one also has.
"""

from __future__ import annotations

import re

from .models import MarketListing

STOPWORDS = {
    "and", "for", "with", "the", "of", "to", "in", "on", "by", "a", "an", "or", "pack", "packs",
    "set", "pcs", "piece", "pieces", "pc", "new", "upgraded", "premium", "1pc", "2pcs", "count",
    "size", "large", "small", "black", "white", "gray", "grey", "fits", "compatible",
}  # fmt: skip
MIN_SIMILARITY = 0.5


def words(title: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", title.lower()) if len(w) > 2 and w not in STOPWORDS}


def search_terms(title: str, limit: int = 7) -> str:
    """The first few meaningful words of a title, to search another marketplace with."""
    seen: list[str] = []
    for w in re.findall(r"[a-z]+", title.lower()):
        if len(w) > 2 and w not in STOPWORDS and w not in seen:
            seen.append(w)
    return " ".join(seen[:limit])


def similarity(a: str, b: str) -> float:
    wa, wb = words(a), words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / min(len(wa), len(wb))


def best_match(listing: MarketListing, found: list[MarketListing]) -> MarketListing | None:
    """The found listing that is most likely the same product, if any is close enough.

    Prices more than 8x apart are a different class of product, whatever the words say.
    """
    good = [
        x for x in found
        if x.price_usd > 0
        and (listing.price_usd <= 0 or 1 / 8 <= x.price_usd / listing.price_usd <= 8)
        and similarity(listing.title, x.title) >= MIN_SIMILARITY
    ]  # fmt: skip
    if not good:
        return None
    return max(
        good, key=lambda x: (round(similarity(listing.title, x.title), 1), x.monthly_sold or 0)
    )
