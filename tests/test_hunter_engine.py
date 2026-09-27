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


# --- suppliers, Amazon/Temu matching and pasted links ------------------------------------

from hunter.categories import CATEGORIES, hunt_categories  # noqa: E402
from hunter.engine import rank_offers  # noqa: E402
from hunter.matching import best_match, search_terms, similarity  # noqa: E402
from hunter.sources.apify import TemuMarket  # noqa: E402
from hunter.sources.base import LinkError  # noqa: E402


def test_a_factory_or_old_shop_wins_a_close_price():
    trader = offer(id="trader", price_cny=10.0, sales=900, is_factory=False, years=1)
    factory = offer(id="factory", price_cny=10.3, sales=900, is_factory=True, years=8)
    cheap = offer(id="cheap", price_cny=8.0, sales=900)
    assert [o.id for o in rank_offers([trader, factory], 500)] == ["factory", "trader"]
    assert rank_offers([trader, factory, cheap], 500)[0].id == "cheap"  # a real saving still wins


def test_candidates_carry_backup_suppliers_and_the_amazon_listing():
    sample = SampleData()
    result = Hunter([sample], sample).hunt()
    gap = next(c for c in result.candidates if "Gap Filler" in c.listing.title)
    assert gap.offer.shop_name and gap.offer.location and gap.offer.price_tiers
    assert [a.id for a in gap.alternatives] == ["s1688-gap-a"]  # the ¥1.9 outlier is dropped
    amazon = next(m for m in gap.matches if m.source == "amazon")
    assert gap.pricing.amazon_usd == amazon.price_usd
    assert gap.pricing.vs_amazon == pytest.approx(
        gap.pricing.price_usd / amazon.price_usd, abs=1e-4
    )
    assert any("آمازون" in p for p in gap.pros)
    assert any("تقاضا" in p and "Temu" in p and "آمازون" in p for p in gap.pros)  # both markets


def test_supplier_details_and_amazon_price_in_the_verdict_reasons():
    p = price_product(10, 0.3, 14.0, CFG, amazon_usd=11.0)
    a = assess(
        listing(price_usd=14.0), offer(is_factory=True, years=9, repurchase_rate=0.4), p, 0.3
    )
    assert any("کارخانه" in x for x in a.pros) and any("سال سابقه" in x for x in a.pros)
    assert any("از آمازون هم گران‌تره" in x for x in a.cons)
    a = assess(listing(price_usd=14.0), offer(years=1, repurchase_rate=0.05), p, 0.3)
    assert any("تازه‌کار" in x for x in a.cons) and any("خرید مجدد پایین" in x for x in a.cons)


def test_title_matching():
    temu = listing(title="Cat Window Perch Hammock with Strong Suction Cups", price_usd=19.99)
    amazon = [
        listing(source="amazon", id="1", title="Dog Bed Orthopedic Large", price_usd=35),
        listing(source="amazon", id="2", title="Cat Window Perch, Hammock Seat with Suction Cups for Indoor Cats", price_usd=29.99, monthly_sold=3000),
        listing(source="amazon", id="3", title="Cat Window Perch Hammock Suction Cups Luxury Edition", price_usd=400),
    ]  # fmt: skip
    assert search_terms(temu.title) == "cat window perch hammock strong suction cups"
    assert similarity(temu.title, amazon[1].title) >= 0.8
    assert best_match(temu, amazon).id == "2"  # #3 is 20x the price: another product
    assert best_match(temu, amazon[:1]) is None


def test_analyze_links_from_both_markets():
    sample = SampleData()
    hunter = Hunter([sample], sample)
    temu_url = next(x.url for x in sample.listings if x.id == "s-cat-perch")
    c = hunter.analyze_url(temu_url)
    assert c.listing.source == "temu" and c.category == "pets"
    assert [m.source for m in c.matches] == ["amazon"] and not c.pricing.benchmark_estimated
    c = hunter.analyze_url(sample.amazon["s-cat-perch"].url)
    assert c.listing.source == "amazon" and [m.source for m in c.matches] == ["temu"]
    assert (
        c.pricing.benchmark_usd == 19.99 and not c.pricing.benchmark_estimated
    )  # Temu's real price
    assert c.title_fa
    with pytest.raises(LinkError, match="listing_not_found"):
        hunter.analyze_url("https://www.temu.com/something-else.html")
    with pytest.raises(LinkError, match="unsupported_link"):
        hunter.analyze_url("https://shop.example.com/item")


def test_keepa_links_and_similar_search():
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, json={"products": [KEEPA_PRODUCT]})

    keepa = Keepa("KEY", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert keepa.handles("https://www.amazon.com/dp/B0TEST") and not keepa.handles(
        "https://temu.com/x"
    )
    got = keepa.listing_by_url("https://www.amazon.com/Car-Seat-Gap/dp/B0CJRVK5Q1?ref=x")
    assert got.id == "B0TEST" and calls[-1].params["asin"] == "B0CJRVK5Q1"
    with pytest.raises(LinkError, match="amazon_site_not_supported"):
        keepa.listing_by_url("https://www.amazon.ae/dp/B0CJRVK5Q1")
    with pytest.raises(LinkError, match="listing_not_found"):
        keepa.listing_by_url("https://www.amazon.com/s?k=gap+filler")
    match = keepa.find_similar(
        listing(title="2 Pack Car Seat Gap Filler with Storage", price_usd=11.99)
    )
    assert match.id == "B0TEST"
    assert calls[-1].path == "/search" and calls[-1].params["type"] == "product"
    assert calls[-1].params["term"] == "car seat gap filler storage"


def test_temu_links_need_the_product_actor():
    seen = {}

    def handler(request):
        seen["url"], seen["body"] = str(request.url), json.loads(request.content)
        return httpx.Response(
            200,
            json=[
                {
                    "title": "Cat Window Perch",
                    "price": 19.99,
                    "url": "https://www.temu.com/g-1.html",
                }
            ],
        )

    apify = Apify("T", client=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(LinkError, match="temu_links_not_configured"):
        TemuMarket(apify, "me/temu-search").listing_by_url("https://www.temu.com/g-1.html")
    temu = TemuMarket(apify, "me/temu-search", product_actor="me/temu-product")
    got = temu.listing_by_url("https://www.temu.com/g-1.html")
    assert got.price_usd == 19.99 and "me~temu-product" in seen["url"]
    assert seen["body"] == {"startUrls": [{"url": "https://www.temu.com/g-1.html"}], "maxItems": 1}
    match = temu.find_similar(
        listing(source="amazon", title="Cat Window Perch for Indoor Cats", price_usd=29.99)
    )
    assert match.price_usd == 19.99 and "me~temu-search" in seen["url"]


def test_1688_shop_details_are_read():
    o = offer_1688({
        "subject": "猫咪吸盘吊床", "price": "21.00", "detailUrl": "https://detail.1688.com/offer/1.html",
        "companyName": "义乌某宠物用品厂", "shopUrl": "https://shop1.1688.com", "province": "浙江 义乌",
        "tpYear": "8", "repurchaseRate": "35%", "priceRanges": [
            {"startQuantity": 100, "price": "19.5"}, {"startQuantity": 2, "price": "21.00"}],
    })  # fmt: skip
    assert (o.shop_name, o.shop_url, o.location, o.years) == (
        "义乌某宠物用品厂",
        "https://shop1.1688.com",
        "浙江 义乌",
        8,
    )
    assert o.is_factory is True and o.repurchase_rate == pytest.approx(0.35)
    assert o.price_tiers == [[2, 21.0], [100, 19.5]]
    trader = offer_1688(
        {"title": "x", "price": 3, "url": "https://1688/2", "shopName": "某贸易公司"}
    )
    assert trader.is_factory is None and trader.price_tiers == []


def test_keepa_domains_cover_the_default():
    assert CATEGORIES["car"].amazon_category_id == 15684181


# --- cost savers: link keys, batched 1688 search, Persian names --------------------------

from types import SimpleNamespace  # noqa: E402

from hunter.db import Database  # noqa: E402
from hunter.links import link_key  # noqa: E402
from hunter.translate import PersianNamer, name_candidates  # noqa: E402


@pytest.mark.parametrize(
    "url,key",
    [
        ("https://www.amazon.com/Car-Seat/dp/B0CJRVK5Q1/ref=sr_1?th=1", "amazon:amazon.com:B0CJRVK5Q1"),
        ("https://amazon.com/gp/product/B0CJRVK5Q1", "amazon:amazon.com:B0CJRVK5Q1"),
        ("https://www.temu.com/car-seat-filler-g-601099517512363.html?_x_ads=1", "temu:601099517512363"),
        ("https://www.temu.com/goods.html?goods_id=601099517512363&refer=x", "temu:601099517512363"),
        ("https://www.temu.com/search_result.html?search_key=cat", "temu.com/search_result.html?search_key=cat"),
    ],
)  # fmt: skip
def test_link_keys_ignore_tracking(url, key):
    assert link_key(url) == key


def test_the_hunt_searches_1688_once_per_category():
    sample = SampleData()

    class Batched:
        def __init__(self):
            self.batches, self.singles = [], 0

        def by_images(self, urls, limit):
            self.batches.append(urls)
            return sample.by_images(urls, limit)

        def by_image(self, url, limit):
            self.singles += 1
            return sample.by_image(url, limit)

        def by_keyword(self, q, limit):
            return []

    supplier = Batched()
    result = Hunter([sample], supplier).hunt()
    assert supplier.singles == 0 and result.candidates
    assert len(supplier.batches) == len(hunt_categories())
    assert all(len(set(b)) == len(b) for b in supplier.batches)


def test_batched_1688_search_maps_results_to_pictures():
    def handler(request):
        body = json.loads(request.content)
        assert body == {"imageUrls": ["https://i/a.jpg", "https://i/b.jpg"], "maxItems": 20}
        return httpx.Response(200, json=[
            {"queryImage": "https://i/a.jpg", "title": "a1", "price": 5, "url": "https://1688/a1"},
            {"queryImage": "https://i/b.jpg", "title": "b1", "price": 7, "url": "https://1688/b1"},
            {"queryImage": "https://i/a.jpg", "title": "a2", "price": 6, "url": "https://1688/a2"},
        ])  # fmt: skip

    apify = Apify("T", client=httpx.Client(transport=httpx.MockTransport(handler)))
    got = Supplier1688(apify, "me/1688").by_images(["https://i/a.jpg", "https://i/b.jpg"], 10)
    assert {k: [o.title for o in v] for k, v in got.items()} == {
        "https://i/a.jpg": ["a1", "a2"],
        "https://i/b.jpg": ["b1"],
    }


def test_untagged_batch_results_fall_back_to_one_search_per_picture():
    def handler(request):
        return httpx.Response(200, json=[{"title": "x", "price": 5, "url": "https://1688/x"}])

    apify = Apify("T", client=httpx.Client(transport=httpx.MockTransport(handler)))
    supplier = Supplier1688(apify, "me/1688")
    assert supplier.by_images(["https://i/a.jpg"], 10) == {}
    assert Supplier1688(apify, "me/1688", batch_input="").by_images(["https://i/a.jpg"], 10) == {}


def test_fill_puts_lists_in_as_json():
    assert fill('{"imageUrls": {image_urls}}', image_urls=["a", 'b"c']) == {
        "imageUrls": ["a", 'b"c']
    }


class FakeClaude:
    """Records requests; answers with Persian names for every id asked."""

    def __init__(self, stop_reason="end_turn", text=None):
        self.requests = []
        self.stop_reason, self.text = stop_reason, text
        self.messages = SimpleNamespace(create=self._create)
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._beta_create))

    def _answer(self, params):
        items = json.loads(params["messages"][0]["content"])
        text = self.text or json.dumps(
            {"items": [{"id": x["id"], "fa": "اسم " + x["id"]} for x in items]}
        )
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)],
        )  # fmt: skip

    def _create(self, **params):
        self.requests.append(("plain", params))
        return self._answer(params)

    def _beta_create(self, **params):
        self.requests.append(("beta", params))
        return self._answer(params)


def test_persian_names_in_batches_with_json_output():
    claude = FakeClaude()
    names = PersianNamer(claude, "claude-opus-5").translate(
        {f"temu:{i}": f"Item {i}" for i in range(30)}
    )
    assert len(names) == 30 and names["temu:7"] == "اسم temu:7"
    kind, params = claude.requests[0]
    assert kind == "beta" and len(claude.requests) == 2  # 25 + 5, with the server-side fallback
    assert params["fallbacks"] == [{"model": "claude-opus-4-8"}]
    assert params["output_config"]["effort"] == "low"
    assert params["output_config"]["format"]["type"] == "json_schema"


def test_a_cheaper_model_skips_effort_and_fallback():
    claude = FakeClaude()
    PersianNamer(claude, "claude-haiku-4-5").translate({"temu:1": "Lamp"})
    kind, params = claude.requests[0]
    assert kind == "plain" and "effort" not in params["output_config"] and "fallbacks" not in params


def test_refusals_and_bad_answers_leave_titles_alone():
    assert (
        PersianNamer(FakeClaude(stop_reason="refusal"), "claude-opus-5").translate({"a": "x"}) == {}
    )
    assert PersianNamer(FakeClaude(text="not json"), "claude-opus-5").translate({"a": "x"}) == {}
    odd = json.dumps({"items": [{"id": "someone-else", "fa": "?"}, {"id": "a", "fa": "  "}]})
    assert PersianNamer(FakeClaude(text=odd), "claude-opus-5").translate({"a": "x"}) == {}


def test_each_product_is_named_once(tmp_path):
    db = Database(tmp_path / "n.db")
    claude = FakeClaude()
    namer = PersianNamer(claude, "claude-opus-5")
    first = [{"listing": {"source": "temu", "id": "1", "title": "Lamp"}, "title_fa": ""},
             {"listing": {"source": "temu", "id": "2", "title": "Mat"}, "title_fa": "زیرانداز"}]  # fmt: skip
    name_candidates(first, namer, db)
    assert first[0]["title_fa"] == "اسم temu:1" and first[1]["title_fa"] == "زیرانداز"
    again = [{"listing": {"source": "temu", "id": "1", "title": "Lamp"}, "title_fa": ""}]
    name_candidates(again, namer, db)
    assert again[0]["title_fa"] == "اسم temu:1" and len(claude.requests) == 1
    name_candidates(
        [{"listing": {"source": "temu", "id": "3", "title": "Cup"}}], None, db
    )  # no key: fine


def test_no_anthropic_key_no_names(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert PersianNamer.from_env() is None
