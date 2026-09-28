"""From the 1688 price to a selling price that beats Temu and still pays the seller.

Costs come in two kinds. Some are money per unit (the factory price, freight by weight,
the unit's share of delivering the order). Others are a cut of the selling price (the
store's commission, the payment gateway, ads, the reserve for returns and refused
cash-on-delivery parcels). So the lowest price that leaves the seller the margin they
want is

    floor = (landed cost + last-mile share) / (1 - all the cuts - target margin)

and the recommended price sits a little under Temu when the floor allows it.

The defaults follow the sellers' contract with the store (RhinoMall): the store keeps 20%
of the final price, and that 20% pays for delivery to the customer, final packaging,
warehousing, ads, promotions and returns (clauses 3-5, 5 and 6-6). So the seller's only
costs are getting the goods to the Dubai warehouse, and

    price = (landed cost + the seller's profit) / 0.8

exactly as the contract's own formula. The other cuts stay configurable for other stores.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field, replace

from .models import Pricing

# The reserve for refused/returned orders, by how customers pay. Under the contract the
# store bears returns (clause 6-6), so there's none; another store would need ~10% prepaid
# and ~22% cash on delivery.
RETURN_RESERVE = {"prepaid": 0.0, "cod": 0.0}

# What the store's 20% pays for (contract clause 5), to show sellers where it goes.
PLATFORM_SPLIT = (
    ("fee", 0.05),  # platform commission
    ("ads", 0.02),  # ads and digital marketing
    ("storage", 0.01),  # warehousing and handling in Dubai
    ("packaging", 0.02),  # final packaging
    ("delivery", 0.08),  # delivery to the customer (Emirates Post)
    ("promo", 0.02),  # promotions and referrals, plus whatever the others didn't use
)


@dataclass(frozen=True)
class PricingConfig:
    cny_per_usd: float = 7.1
    platform_pct: float = 0.20  # the store's share: everything after the Dubai warehouse
    platform_split: tuple[tuple[str, float], ...] = PLATFORM_SPLIT
    gateway_pct: float = 0.0  # buyers pay the store (contract clause 6-2)
    marketing_pct: float = 0.0  # ads are in the store's share; set for your own promotions
    returns_pct: float = RETURN_RESERVE["prepaid"]
    target_margin: float = 0.15  # what's left for the seller, as a share of the price
    china_side_pct: float = 0.10  # buying agent + trucking to the port, on the factory price
    freight_usd_per_kg: float = 2.5  # China -> Dubai, consolidated
    packaging_usd: float = 0.0  # final packaging is the store's; set for packaging bought in China
    # Delivering one order from the Dubai warehouse, by the product's weight: the store's,
    # inside its share (contract clause 3-5). Another store: e.g. ((0.5, 4), (2, 6.5), (inf, 11)).
    last_mile_usd: tuple[tuple[float, float], ...] = field(default=((float("inf"), 0.0),))
    items_per_cart: int = 3  # one delivery is shared by the items in an order
    undercut: float = 0.05  # aim this much under Temu when the numbers allow
    max_premium: float = 0.10  # above Temu by more than this, it won't sell
    temu_vs_amazon: float = 0.60  # Temu is ~60% of Amazon's price, to estimate Temu
    max_moq: int = 500  # skip offers that need bigger first orders
    min_starter_qty: int = 50  # smallest sensible first shipment
    license_usd: float = 10_000  # the store panel's licence, in 10 instalments (clause 4-1)
    license_installments: int = 10  # earlier partners are exempt (clause 4-2): license_usd 0
    max_shelf_months: float = 4  # unsold stock older than this may be removed (clause 11-5)

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
            marketing_pct=float(env("HUNTER_MARKETING_PCT", "0")) / 100,
            target_margin=float(env("HUNTER_TARGET_MARGIN_PCT", "15")) / 100,
            freight_usd_per_kg=float(env("HUNTER_FREIGHT_USD_PER_KG", "2.5")),
            license_usd=float(env("HUNTER_LICENSE_USD", "10000")),
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
    amazon_usd: float | None = None,
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
        amazon_usd=round(amazon_usd, 2) if amazon_usd else None,
        vs_amazon=round(price / amazon_usd, 4) if amazon_usd else None,
    )
