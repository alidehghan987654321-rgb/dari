"""From the 1688 price to a selling price that beats Temu and still pays the seller.

Costs come in two kinds. Some are money per unit (the factory price, freight by weight,
the unit's share of delivering the order). Others are a cut of the selling price (the
store's commission, the payment gateway, ads, the reserve for returns and refused
cash-on-delivery parcels). So the lowest price that leaves the seller the margin they
want is

    floor = (landed cost + last-mile share) / (1 - all the cuts - target margin)

and the recommended price sits a little under Temu when the floor allows it.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field, replace

from .models import Pricing

# Refused/returned share of orders, by how customers pay. Paid online (like Temu), few
# come back; cash on delivery, common in the Gulf and Asia, is refused a lot at the door.
RETURN_RESERVE = {"prepaid": 0.10, "cod": 0.22}


@dataclass(frozen=True)
class PricingConfig:
    cny_per_usd: float = 7.1
    platform_pct: float = 0.20  # the store's cut: warehouse and the rest
    gateway_pct: float = 0.028
    marketing_pct: float = 0.05  # the seller's own promotions; the store brings the traffic
    returns_pct: float = RETURN_RESERVE["prepaid"]
    target_margin: float = 0.15  # what's left for the seller, as a share of the price
    china_side_pct: float = 0.10  # buying agent + trucking to the port, on the factory price
    freight_usd_per_kg: float = 2.5  # China -> Dubai, consolidated
    packaging_usd: float = 0.15
    # Delivering one order from the Dubai warehouse, by the product's weight.
    last_mile_usd: tuple[tuple[float, float], ...] = field(
        default=((0.5, 4.0), (2.0, 6.5), (float("inf"), 11.0))
    )
    items_per_cart: int = 3  # one delivery is shared by the items in an order
    undercut: float = 0.05  # aim this much under Temu when the numbers allow
    max_premium: float = 0.10  # above Temu by more than this, it won't sell
    temu_vs_amazon: float = 0.60  # Temu is ~60% of Amazon's price, to estimate Temu
    max_moq: int = 500  # skip offers that need bigger first orders
    min_starter_qty: int = 50  # smallest sensible first shipment

    @property
    def cuts(self) -> float:
        return self.platform_pct + self.gateway_pct + self.marketing_pct + self.returns_pct

    @classmethod
    def from_env(cls) -> PricingConfig:
        """Defaults, overridden by HUNTER_* settings (percentages as whole numbers)."""
        env = os.environ.get
        return cls(
            cny_per_usd=float(env("HUNTER_CNY_PER_USD", "7.1")),
            platform_pct=float(env("HUNTER_PLATFORM_PCT", "20")) / 100,
            marketing_pct=float(env("HUNTER_MARKETING_PCT", "5")) / 100,
            target_margin=float(env("HUNTER_TARGET_MARGIN_PCT", "15")) / 100,
            freight_usd_per_kg=float(env("HUNTER_FREIGHT_USD_PER_KG", "2.5")),
        ).for_market(env("HUNTER_MARKET", "prepaid"))

    def for_market(self, market: str) -> PricingConfig:
        return replace(self, returns_pct=RETURN_RESERVE[market])

    def last_mile_for(self, weight_kg: float) -> float:
        for max_kg, cost in self.last_mile_usd:
            if weight_kg <= max_kg:
                return cost
        return self.last_mile_usd[-1][1]


class Unprofitable(ValueError):
    """The cuts and the target margin add up to the whole price: no price works."""


def charm(price: float) -> float:
    """Round up to the next .49 or .99."""
    return math.ceil((price + 0.01) * 2) / 2 - 0.01


def charm_down(price: float) -> float:
    """Round down to the previous .49 or .99."""
    return math.floor((price + 0.01) * 2) / 2 - 0.01


def price_product(
    price_cny: float,
    weight_kg: float,
    benchmark_usd: float | None,
    cfg: PricingConfig,
    *,
    benchmark_estimated: bool = False,
    units: int = 1,
) -> Pricing:
    """Cost out one sold listing (``units`` supplier pieces) and pick its price."""
    keep = 1 - cfg.cuts
    if keep - cfg.target_margin <= 0.02:
        raise Unprofitable(
            f"Commission, gateway, ads and returns take {cfg.cuts:.0%} of the price; "
            f"with a {cfg.target_margin:.0%} margin on top no price works."
        )

    factory = price_cny * units / cfg.cny_per_usd
    china_side = factory * cfg.china_side_pct
    freight = weight_kg * cfg.freight_usd_per_kg
    landed = factory + china_side + freight + cfg.packaging_usd
    last_mile = cfg.last_mile_for(weight_kg) / max(1, cfg.items_per_cart)
    unit_cost = landed + last_mile

    floor = unit_cost / (keep - cfg.target_margin)
    breakeven = unit_cost / keep
    price = charm(floor)
    if benchmark_usd:
        # Just under Temu when that still leaves the margin; otherwise the floor.
        under = charm_down(benchmark_usd * (1 - cfg.undercut))
        if under >= floor:
            price = under

    profit = price * keep - unit_cost
    return Pricing(
        factory_usd=round(factory, 2),
        china_side_usd=round(china_side, 2),
        freight_usd=round(freight, 2),
        packaging_usd=round(cfg.packaging_usd, 2),
        landed_usd=round(landed, 2),
        last_mile_usd=round(last_mile, 2),
        price_usd=round(price, 2),
        floor_usd=round(floor, 2),
        breakeven_usd=round(breakeven, 2),
        platform_fee_usd=round(price * cfg.platform_pct, 2),
        gateway_usd=round(price * cfg.gateway_pct, 2),
        marketing_usd=round(price * cfg.marketing_pct, 2),
        returns_reserve_usd=round(price * cfg.returns_pct, 2),
        profit_usd=round(profit, 2),
        margin=round(profit / price, 4),
        roi=round(profit / landed, 4),
        multiplier=round(price / factory, 2) if factory else 0.0,
        benchmark_usd=round(benchmark_usd, 2) if benchmark_usd else None,
        benchmark_estimated=benchmark_estimated,
        vs_benchmark=round(price / benchmark_usd, 4) if benchmark_usd else None,
    )
