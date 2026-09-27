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
    # Who sells it: what a seller needs to buy from the right shop.
    shop_name: str = ""
    shop_url: str = ""
    location: str = ""  # province / city
    years: int | None = None  # years on 1688
    is_factory: bool | None = None  # a factory, not a trading company
    repurchase_rate: float | None = None  # 0-1, buyers who ordered again
    rating: float | None = None  # 0-5
    price_tiers: list[list[float]] = field(default_factory=list)  # [[from qty, price], ...]


@dataclass
class OfferDetail:
    """Everything on a 1688 offer page, to show inside our site (sellers in Iran can't
    open or sign up on 1688)."""

    offer: SupplierOffer  # price, MOQ, shop and its record
    images: list[str] = field(default_factory=list)
    attributes: list[list[str]] = field(default_factory=list)  # [[name, value], ...]
    skus: list[dict] = field(default_factory=list)  # {"name", "price_cny", "stock"}
    badges: list[str] = field(default_factory=list)  # shop and service badges, as on 1688
    title_fa: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


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
    amazon_usd: float | None = None  # the same (or a very similar) product on Amazon
    vs_amazon: float | None = None  # price / Amazon's price


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
    alternatives: list[SupplierOffer] = field(default_factory=list)  # other shops for the same item
    matches: list[MarketListing] = field(default_factory=list)  # the product on the other markets
    level: dict = field(default_factory=dict)  # the supplier's level, see scoring.supplier_level
    is_new: bool = False  # not in the previous daily hunt

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Candidate:
        d = dict(d)
        d["listing"] = MarketListing(**d["listing"])
        d["offer"] = SupplierOffer(**d["offer"])
        d["alternatives"] = [SupplierOffer(**o) for o in d.get("alternatives", [])]
        d["matches"] = [MarketListing(**x) for x in d.get("matches", [])]
        d["pricing"] = Pricing(**d["pricing"])
        return cls(**d)
