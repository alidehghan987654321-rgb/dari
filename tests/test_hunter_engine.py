import json

import httpx
import pytest

from hunter.categories import classify, ip_matches, pack_qty, restricted_matches
from hunter.engine import Hunter, pick_offer
from hunter.models import Candidate, MarketListing, SupplierOffer
from hunter.pricing import PricingConfig, Unprofitable, charm, charm_down, price_product
from hunter.scoring import assess
from hunter.sources.apify import Apify, Supplier1688, fill, offer_1688, temu_listing
from hunter.sources.base import to_count, to_number
from hunter.sources.keepa import Keepa, to_listing
from hunter.sources.sample import SampleData

CFG = PricingConfig()


def listing(**kw):
    base = dict(
        source="temu",
        id="x",
        title="Thing",
        url="https://t/x",
        image_url="img://x",
        price_usd=12.0,
        category="car",
        monthly_sold=2000,
        reviews=300,
    )
    return MarketListing(**{**base, **kw})


def offer(**kw):
    base = dict(
        id="o", title="东西", url="https://1688/o", image_url="", price_cny=10.0, moq=5, sales=800
    )
    return SupplierOffer(**{**base, **kw})


# --- pricing -------------------------------------------------------------------------


def test_charm_rounds_to_49_and_99():
    assert charm(12.3) == pytest.approx(12.49)
    assert charm(12.49) == pytest.approx(12.49)
    assert charm(12.5) == pytest.approx(12.99)
    assert charm_down(11.39) == pytest.approx(10.99)
    assert charm_down(11.49) == pytest.approx(11.49)


def test_floor_leaves_exactly_the_target_margin():
    p = price_product(10, 0.3, None, CFG)
    unit_cost = p.landed_usd + p.last_mile_usd
    keep = 1 - CFG.cuts
    assert p.floor_usd == pytest.approx(unit_cost / (keep - CFG.target_margin), abs=0.01)
    assert p.breakeven_usd == pytest.approx(unit_cost / keep, abs=0.01)
    assert p.price_usd >= p.floor_usd
    assert p.margin >= CFG.target_margin


def test_price_goes_just_under_temu_when_that_still_pays():
    p = price_product(10, 0.3, 20.0, CFG)
    assert p.price_usd < 20 * (1 - CFG.undercut) + 0.001
    assert p.price_usd > p.floor_usd
    assert p.vs_benchmark < 1


def test_price_stays_at_floor_when_temu_is_too_cheap():
    p = price_product(40, 1.0, 5.0, CFG)
    assert p.price_usd == charm(p.floor_usd)
    assert p.vs_benchmark > 1


def test_units_multiply_the_factory_price():
    one = price_product(10, 0.3, None, CFG)
    two = price_product(10, 0.3, None, CFG, units=2)
    assert two.factory_usd == pytest.approx(2 * one.factory_usd, abs=0.01)


def test_last_mile_depends_on_weight_and_is_shared_by_the_cart():
    assert CFG.last_mile_for(0.2) == 4.0
    assert CFG.last_mile_for(1.5) == 6.5
    assert CFG.last_mile_for(9) == 11.0
    assert price_product(10, 0.2, None, CFG).last_mile_usd == pytest.approx(4.0 / 3, abs=0.01)


def test_impossible_settings_raise():
    with pytest.raises(Unprofitable):
        price_product(10, 0.3, None, PricingConfig(marketing_pct=0.5, target_margin=0.3))


def test_cash_on_delivery_market_reserves_more_for_returns():
    assert CFG.for_market("cod").returns_pct > CFG.for_market("prepaid").returns_pct


# --- categories ------------------------------------------------------------------------


def test_restricted_products_are_spotted_by_title():
    assert [c.key for c in restricted_matches("Rechargeable Car Vacuum")] == ["batteries"]
    assert [c.key for c in restricted_matches("Montessori busy board for toddlers")] == [
        "kids_toys"
    ]
    assert restricted_matches("Car Seat Gap Filler") == []
    assert restricted_matches("Cat Window Perch") == []  # "cat" is not "catalog"-style noise


def test_brand_risk_is_spotted():
    assert ip_matches("Magnetic Mount Compatible with MagSafe") == ["magsafe"]
    assert ip_matches("Plain silicone lid") == []


def test_classify_prefers_hint_but_restricted_wins():
    assert classify("Anything", "pets") == "pets"
    assert classify("Rechargeable fan", "home_kitchen") == "batteries"
    assert classify("Dog lick mat") == "pets"


@pytest.mark.parametrize(
    "title,n",
    [
        ("2 Pack Car Seat Gap Filler", 2),
        ("Packing Cubes, 6 Set", 1),
        ("Organizer set of 6", 6),
        ("12 pcs lids", 12),
        ("硅胶保鲜盖 12件套", 12),
        ("Cup holder for 40 oz bottles", 1),
        ("Lamp", 1),
    ],
)
def test_pack_qty(title, n):
    assert pack_qty(title) == n


# --- scoring ---------------------------------------------------------------------------


def test_green_when_cheaper_than_temu_with_demand_and_margin():
    p = price_product(10, 0.3, 14.0, CFG)
    a = assess(listing(price_usd=14.0, monthly_sold=4000), offer(sales=2000), p, 0.3)
    assert a.verdict == "green"
    assert a.score >= 70


def test_red_when_the_floor_is_well_above_temu():
    p = price_product(40, 1.0, 5.0, CFG)
    a = assess(listing(price_usd=5.0), offer(price_cny=40), p, 1.0)
    assert a.verdict == "red"
    assert any("رقابتی نیست" in c for c in a.cons)


def test_red_for_restricted_even_if_profitable():
    p = price_product(10, 0.3, 14.0, CFG)
    a = assess(listing(title="Rechargeable mini fan", price_usd=14.0), offer(), p, 0.3)
    assert a.verdict == "red"
    assert any("باتری" in f for f in a.flags)


def test_brand_risk_caps_at_yellow():
    p = price_product(10, 0.3, 14.0, CFG)
    a = assess(
        listing(title="Stand for MagSafe", price_usd=14.0, monthly_sold=5000),
        offer(sales=3000),
        p,
        0.3,
    )
    assert a.verdict == "yellow"
    assert any("برند" in f for f in a.flags)


# --- offers & the hunt -----------------------------------------------------------------


def test_pick_offer_skips_outliers_and_unproven_and_big_moq():
    offers = [
        offer(id="cheap-junk", price_cny=1.0, sales=5000),  # far below the rest: another item
        offer(id="unproven", price_cny=6.0, sales=3),
        offer(id="proven", price_cny=7.0, sales=900),
        offer(id="huge-moq", price_cny=5.0, sales=900, moq=5000),
        offer(id="dear", price_cny=9.0, sales=900),
    ]
    assert pick_offer(offers, max_moq=500).id == "proven"
    assert pick_offer([offer(moq=1000)], max_moq=500) is None


def test_sample_hunt():
    sample = SampleData()
    result = Hunter([sample], sample).hunt()
    by_verdict = {
        v: [c for c in result.candidates if c.verdict == v] for v in ("green", "yellow", "red")
    }
    assert len(result.candidates) == len(sample.listings)
    assert by_verdict["green"] and by_verdict["yellow"] and by_verdict["red"]
    vacuum = next(c for c in result.candidates if "Vacuum" in c.listing.title)
    assert vacuum.verdict == "red" and vacuum.category == "batteries"
    # Greens come first, and every green is priced at or under Temu.
    assert result.candidates[0].verdict == "green"
    assert all(c.pricing.vs_benchmark <= 1.03 for c in by_verdict["green"])
    gap = next(c for c in result.candidates if "Gap Filler" in c.listing.title)
    assert gap.pack_qty == 2 and gap.title_fa
    assert gap.starter_capital_usd == pytest.approx(
        gap.starter_qty * gap.pricing.landed_usd, abs=0.01
    )
    # Candidates survive a round trip through JSON (how they're stored).
    again = Candidate.from_dict(json.loads(json.dumps(gap.to_dict())))
    assert again.pricing.price_usd == gap.pricing.price_usd


def test_hunt_keeps_one_candidate_per_supplier_offer_and_counts_skips():
    class Market:
        name = "m"

        def trending(self, category, limit):
            if category.key != "car":
                return []
            return [
                listing(id="a", image_url="img"),
                listing(id="b", image_url="img", monthly_sold=10),
                listing(id="c", image_url="none"),
            ]

    class Supplier:
        def by_image(self, url, limit):
            return [offer(id="same")] if url == "img" else []

        def by_keyword(self, q, limit):
            return []

    result = Hunter([Market()], Supplier()).hunt()
    assert [c.listing.id for c in result.candidates] == ["a"]
    assert result.skipped == {"no_supplier": 1}


def test_a_failing_market_is_skipped_not_fatal():
    class Broken:
        name = "broken"

        def trending(self, category, limit):
            raise httpx.ConnectError("down")

    sample = SampleData()
    result = Hunter([Broken(), sample], sample).hunt()
    assert result.candidates and result.skipped["market_error"] > 0


# --- reading API fields ---------------------------------------------------------------


def test_numbers_and_counts_from_messy_fields():
    assert to_number("¥12.50") == 12.5
    assert to_number("12.5-15") == 12.5
    assert to_number("12.5-15", highest=True) == 15
    assert to_number({"value": "$9.99"}) == 9.99
    assert to_number("free") is None
    assert to_count("10K+ sold") == 10_000
    assert to_count("2.5万+") == 25_000
    assert to_count("1,234") == 1234


def test_fill_escapes_values():
    payload = fill('{"q": ["{query}"], "n": {limit}}', query='a "b"', limit=5)
    assert payload == {"q": ['a "b"'], "n": 5}


KEEPA_PRODUCT = {
    "asin": "B0TEST",
    "title": "Car Seat Gap Filler 2 Pack",
    "images": [{"l": "big.jpg", "m": "mid.jpg"}],
    "packageWeight": 380,
    "monthlySold": 5000,
    "stats": {"current": [-1, 1599, -1] + [0] * 13 + [46, 1800, 1699]},
}


def test_keepa_product_to_listing():
    x = to_listing(KEEPA_PRODUCT, "car")
    assert x.price_usd == 16.99  # buy box with shipping first
    assert x.rating == 4.6 and x.reviews == 1800 and x.monthly_sold == 5000
    assert x.weight_kg == 0.38
    assert x.image_url == "https://m.media-amazon.com/images/I/big.jpg"
    assert x.url == "https://www.amazon.com/dp/B0TEST"
    assert to_listing({"asin": "B1", "stats": {"current": [-1, -1]}}, "car") is None


def test_keepa_trending_calls_bestsellers_then_product():
    calls = []

    def handler(request):
        calls.append(request.url)
        if request.url.path == "/bestsellers":
            return httpx.Response(200, json={"bestSellersList": {"asinList": ["B0TEST", "B0NONE"]}})
        return httpx.Response(200, json={"products": [KEEPA_PRODUCT]})

    from hunter.categories import CATEGORIES

    keepa = Keepa("KEY", client=httpx.Client(transport=httpx.MockTransport(handler)))
    got = keepa.trending(CATEGORIES["car"], 5)
    assert [x.id for x in got] == ["B0TEST"]
    assert calls[0].params["category"] == "15684181" and calls[0].params["key"] == "KEY"
    assert calls[1].params["asin"] == "B0TEST,B0NONE" and calls[1].params["stats"] == "30"


def test_temu_and_1688_items_are_normalised():
    t = temu_listing(
        {
            "title": "Mat",
            "price": "$5.49",
            "url": "https://temu/x",
            "soldCount": "70K+ sold",
            "images": ["https://img/1.jpg"],
            "reviewCount": "12,000",
        },
        "pets",
    )
    assert (t.price_usd, t.sold_total, t.reviews, t.image_url) == (
        5.49,
        70_000,
        12_000,
        "https://img/1.jpg",
    )
    assert temu_listing({"title": "no price", "url": "u"}, "pets") is None
    o = offer_1688(
        {
            "subject": "舔食垫",
            "priceRange": "¥2.80-3.20",
            "detailUrl": "https://1688/o/1",
            "quantityBegin": 20,
            "saleCount": "9000",
        }
    )
    assert (o.price_cny, o.moq, o.sales, o.title) == (3.2, 20, 9000, "舔食垫")


def test_apify_runs_the_actor_with_the_filled_input():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            201, json=[{"title": "x", "price": 3, "url": "https://1688/1", "sales": 60}]
        )

    apify = Apify("TOKEN", client=httpx.Client(transport=httpx.MockTransport(handler)))
    got = Supplier1688(apify, "someone/1688-image").by_image("https://img/a.jpg", 5)
    assert "acts/someone~1688-image/run-sync-get-dataset-items" in seen["url"]
    assert "token=TOKEN" in seen["url"]
    assert seen["body"] == {"imageUrls": ["https://img/a.jpg"], "maxItems": 5}
    assert got[0].price_cny == 3
