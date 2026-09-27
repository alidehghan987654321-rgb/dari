"""The data that moves through the hunt: listings, supplier offers and scored finds."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class MarketListing:
    """A product that sells on a marketplace: the demand side and the price to beat."""

    source: str  # "temu" or "amazon"
    id: str
    title: str
    url: str
    image_url: str
    price_usd: float
    category: str = ""  # category key from hunter.categories
    monthly_sold: int | None = None
    sold_total: int | None = None  # Temu shows lifetime "10K+ sold", not per month
    reviews: int | None = None
    rating: float | None = None
    weight_kg: float | None = None
    title_fa: str = ""  # Persian name, when known


@dataclass
class SupplierOffer:
    """A 1688 offer for (what looks like) the same product."""

    id: str
    title: str
    url: str
    image_url: str
    price_cny: float  # per piece, at the minimum order
    moq: int = 1
    sales: int | None = None  # 1688's sold/transactions count for the offer
    weight_kg: float | None = None


@dataclass
class Pricing:
    """Every cost of one sold unit, at the recommended selling price."""

    factory_usd: float
    china_side_usd: float  # agent fee + trucking inside China
    freight_usd: float  # China -> Dubai warehouse
    packaging_usd: float
    landed_usd: float  # all of the above: what one unit costs on the shelf in Dubai
    last_mile_usd: float  # this unit's share of delivering the order
    price_usd: float  # recommended selling price
    floor_usd: float  # lowest price that still leaves the target margin
    breakeven_usd: float  # zero profit
    platform_fee_usd: float
    gateway_usd: float
    marketing_usd: float
    returns_reserve_usd: float
    profit_usd: float
    margin: float  # profit / price
    roi: float  # profit / landed cost
    multiplier: float  # price / factory price
    benchmark_usd: float | None  # Temu's price (or an estimate of it)
    benchmark_estimated: bool
    vs_benchmark: float | None  # price / benchmark


@dataclass
class Candidate:
    """A scored find, ready to hand to a seller."""

    id: str
    category: str
    listing: MarketListing
    offer: SupplierOffer
    pack_qty: int
    weight_kg: float
    pricing: Pricing
    score: int
    verdict: str  # "green", "yellow" or "red"
    pros: list[str] = field(default_factory=list)
    cons: list[str] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    title_fa: str = ""
    starter_qty: int = 0
    starter_capital_usd: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Candidate:
        d = dict(d)
        d["listing"] = MarketListing(**d["listing"])
        d["offer"] = SupplierOffer(**d["offer"])
        d["pricing"] = Pricing(**d["pricing"])
        return cls(**d)
