"""Handing finds to sellers so they don't end up selling the same thing against each other.

Each product goes to at most a few sellers, matching the categories they chose and what
they can afford to start with (the first shipment's cost).
"""

from __future__ import annotations

from typing import Any


def choose_picks(
    candidates: list[dict[str, Any]],
    categories: list[str],
    budget_usd: float,
    taken: dict[str, int],
    per_product: int = 3,
    max_picks: int = 8,
) -> list[str]:
    """Candidate IDs for one seller. ``taken`` counts how many sellers have each already."""
    order = {"green": 0, "yellow": 1}
    eligible = sorted(
        (
            c
            for c in candidates
            if c["verdict"] in order
            and (not categories or c["category"] in categories)
            and taken.get(c["id"], 0) < per_product
        ),
        key=lambda c: (order[c["verdict"]], -c["score"]),
    )
    chosen: list[str] = []
    left = budget_usd
    for c in eligible:
        if len(chosen) >= max_picks:
            break
        if c["starter_capital_usd"] <= left:
            chosen.append(c["id"])
            left -= c["starter_capital_usd"]
    return chosen
