import json

import httpx
import pytest
from fastapi.testclient import TestClient

from hunter.app import Settings, create_app
from hunter.db import Database
from hunter.engine import Hunter
from hunter.payments import DemoGateway, PaymentError, Zarinpal
from hunter.preview import build_preview
from hunter.sources.sample import SampleData

PASSWORD = "secret-pass"


@pytest.fixture(scope="module")
def sample_hunt():
    sample = SampleData()
    result = Hunter([sample], sample).hunt()
    result.sample, result.note = True, sample.note
    return result.to_dict()


@pytest.fixture
def settings(tmp_path, sample_hunt):
    path = str(tmp_path / "h.db")
    Database(path).save_hunt(sample_hunt)
    return Settings(db_path=path, gateway=DemoGateway(), public_url="http://testserver")


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c


def signup(client, email="seller@example.com", **extra):
    body = {
        "name": "فروشنده",
        "email": email,
        "phone": "09120000000",
        "password": PASSWORD,
        **extra,
    }
    r = client.post("/api/signup", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def subscribe(client, plan="monthly"):
    r = client.post("/api/pay", json={"plan": plan})
    assert r.status_code == 200, r.text
    return client.get(
        r.json()["redirect_url"].replace("http://testserver", ""), follow_redirects=False
    )


def test_pages_and_config(client):
    assert "app:start" in client.get("/").text
    assert client.get("/static/app.js").status_code == 200
    cfg = client.get("/api/config").json()  # would fail on float('inf') in the settings
    assert cfg["online_payment"] is True
    assert {p["id"] for p in cfg["plans"]} == {"monthly", "quarterly"}
    assert cfg["pricing"]["last_mile_usd"][-1][0] is None
    assert any(c["restricted"] for c in cfg["categories"])


def test_visitors_see_a_locked_teaser_only(client):
    h = client.get("/api/hunt").json()
    assert h["locked"] is True and h["sample"] is True
    assert 0 < len(h["candidates"]) <= 3
    for c in h["candidates"]:
        assert c["verdict"] == "green"
        assert "pricing" not in c and "offer" not in c  # no way to buy it without paying


def test_signup_login_logout(client):
    me = signup(client, email="Mixed@Example.COM")
    assert me["email"] == "mixed@example.com" and me["active"] is False
    assert (
        client.post(
            "/api/signup", json={"name": "x y", "email": "mixed@example.com", "password": PASSWORD}
        ).status_code
        == 409
    )
    client.post("/api/logout")
    assert client.get("/api/me").status_code == 401
    assert (
        client.post(
            "/api/login", json={"email": "mixed@example.com", "password": "nope"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/login", json={"email": "MIXED@example.com", "password": PASSWORD}
        ).status_code
        == 200
    )
    assert client.get("/api/me").json()["email"] == "mixed@example.com"


def test_bad_signups_are_refused(client):
    assert (
        client.post(
            "/api/signup", json={"name": "ab", "email": "not-an-email", "password": PASSWORD}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/signup", json={"name": "ab", "email": "a@b.co", "password": "short"}
        ).status_code
        == 422
    )


def test_login_is_throttled(client):
    signup(client)
    client.post("/api/logout")
    for _ in range(8):
        client.post("/api/login", json={"email": "seller@example.com", "password": "wrong"})
    r = client.post("/api/login", json={"email": "seller@example.com", "password": PASSWORD})
    assert r.status_code == 429


def test_paying_unlocks_everything(client):
    signup(client)
    assert client.get("/api/picks").status_code == 402
    assert client.post("/api/analyze", json={"price_cny": 10, "weight_kg": 0.3}).status_code == 402
    r = subscribe(client)
    assert r.status_code == 303 and r.headers["location"] == "/#paid"
    me = client.get("/api/me").json()
    assert me["active"] is True and me["paid_until"]
    h = client.get("/api/hunt").json()
    assert (
        h["locked"] is False
        and len(h["candidates"])
        == h["counts"]["green"] + h["counts"]["yellow"] + h["counts"]["red"]
    )


def test_a_replayed_callback_does_not_extend_twice(client, settings):
    signup(client)
    r = client.post("/api/pay", json={"plan": "monthly"})
    callback = r.json()["redirect_url"].replace("http://testserver", "")
    client.get(callback, follow_redirects=False)
    first = client.get("/api/me").json()["paid_until"]
    assert client.get(callback, follow_redirects=False).headers["location"] == "/#paid"
    assert client.get("/api/me").json()["paid_until"] == first


def test_cancelled_or_unknown_payments_do_nothing(client):
    signup(client)
    r = client.post("/api/pay", json={"plan": "monthly"})
    authority = r.json()["redirect_url"].split("Authority=")[1].split("&")[0]
    r = client.get(f"/pay/callback?Authority={authority}&Status=NOK", follow_redirects=False)
    assert r.headers["location"] == "/#pay-cancelled"
    r = client.get("/pay/callback?Authority=DEMO-forged&Status=OK", follow_redirects=False)
    assert r.headers["location"] == "/#pay-failed"
    assert client.get("/api/me").json()["active"] is False
    assert client.post("/api/pay", json={"plan": "lifetime"}).status_code == 404


def test_without_a_gateway_payment_is_offline(settings):
    settings.gateway = None
    with TestClient(create_app(settings)) as c:
        signup(c)
        assert c.get("/api/config").json()["online_payment"] is False
        assert c.post("/api/pay", json={"plan": "monthly"}).status_code == 503


def test_admin_grant_activates_a_seller(client, settings):
    signup(client)
    assert Database(settings.db_path).grant("seller@example.com", 30)
    assert client.get("/api/me").json()["active"] is True
    assert Database(settings.db_path).grant("nobody@example.com", 30) is None


def test_picks_follow_categories_and_budget(client):
    signup(client)
    subscribe(client)
    client.put(
        "/api/me",
        json={
            "name": "فروشنده",
            "phone": "",
            "categories": ["car", "pets", "bogus"],
            "budget_usd": 450,
        },
    )
    assert client.get("/api/me").json()["categories"] == ["car", "pets"]
    p = client.get("/api/picks").json()
    assert p["candidates"]
    assert {c["category"] for c in p["candidates"]} <= {"car", "pets"}
    assert all(c["verdict"] in ("green", "yellow") for c in p["candidates"])
    assert p["capital_usd"] <= 450
    assert client.get("/api/picks").json()["candidates"] == p["candidates"]  # stable


def test_each_product_goes_to_a_few_sellers_only(settings):
    settings.per_product = 2
    got = []
    with TestClient(create_app(settings)) as c:
        for i in range(3):
            c.cookies.clear()
            signup(c, email=f"s{i}@example.com")
            subscribe(c)
            c.put(
                "/api/me",
                json={"name": "فروشنده", "phone": "", "categories": ["pets"], "budget_usd": 5000},
            )
            got.append([x["id"] for x in c.get("/api/picks").json()["candidates"]])
    perch = "temu:s-cat-perch"
    assert perch in got[0] and perch in got[1] and perch not in got[2]


def test_analyze_a_product(client):
    signup(client)
    subscribe(client)
    body = {
        "title": "Car Seat Gap Filler 2 Pack",
        "price_cny": 6.65,
        "weight_kg": 0.4,
        "temu_price_usd": 11.99,
        "listing_pack": 2,
        "moq": 10,
        "monthly_sold": 5000,
        "reviews": 1800,
    }
    a = client.post("/api/analyze", json=body).json()
    assert a["verdict"] == "green" and a["category"] == "car" and a["pack_qty"] == 2
    assert a["pricing"]["price_usd"] < 11.99
    vac = client.post(
        "/api/analyze",
        json={
            "title": "Rechargeable car vacuum",
            "price_cny": 38,
            "weight_kg": 0.8,
            "temu_price_usd": 19.99,
        },
    ).json()
    assert vac["verdict"] == "red" and vac["flags"]
    cod = client.post("/api/analyze", json={**body, "market": "cod"}).json()
    assert cod["pricing"]["returns_reserve_usd"] > a["pricing"]["returns_reserve_usd"]
    assert client.post("/api/analyze", json={**body, "price_cny": -1}).status_code == 422


# --- Zarinpal ----------------------------------------------------------------------------


def zarinpal(handler, sandbox=True):
    return Zarinpal(
        "MERCHANT", sandbox=sandbox, client=httpx.Client(transport=httpx.MockTransport(handler))
    )


def test_zarinpal_request_and_verify():
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append((request.url.path, body))
        if request.url.path.endswith("request.json"):
            return httpx.Response(
                200, json={"data": {"code": 100, "authority": "A0001"}, "errors": []}
            )
        ok = body["amount"] == 10_000_000
        return httpx.Response(
            200,
            json={"data": {"code": 100, "ref_id": 201}, "errors": []}
            if ok
            else {"data": [], "errors": {"code": -50, "message": "amount"}},
        )

    z = zarinpal(handler)
    authority, url = z.start(10_000_000, "اشتراک", "https://site/pay/callback", "a@b.co", "")
    assert (authority, url) == ("A0001", "https://sandbox.zarinpal.com/pg/StartPay/A0001")
    assert seen[0] == (
        "/pg/v4/payment/request.json",
        {
            "merchant_id": "MERCHANT",
            "amount": 10_000_000,
            "description": "اشتراک",
            "callback_url": "https://site/pay/callback",
            "metadata": {"email": "a@b.co"},
        },
    )
    assert z.verify("A0001", 10_000_000) == "201"
    assert z.verify("A0001", 5) is None  # the gateway disagrees about the amount


def test_zarinpal_refusal_and_already_verified():
    def refuse(request):
        return httpx.Response(200, json={"data": [], "errors": {"code": -9, "message": "bad"}})

    with pytest.raises(PaymentError):
        zarinpal(refuse).start(1000, "x", "https://s/cb", "", "")

    def again(request):
        return httpx.Response(200, json={"data": {"code": 101, "ref_id": 7}, "errors": []})

    assert zarinpal(again, sandbox=False).verify("A", 1000) == "7"
    assert zarinpal(again, sandbox=False).host == "https://payment.zarinpal.com"


def test_payment_verified_by_zarinpal_through_the_site(settings):
    amounts = []

    def handler(request):
        body = json.loads(request.content)
        if request.url.path.endswith("request.json"):
            return httpx.Response(200, json={"data": {"code": 100, "authority": "A77"}})
        amounts.append(body["amount"])
        return httpx.Response(200, json={"data": {"code": 100, "ref_id": 9}})

    settings.gateway = zarinpal(handler)
    with TestClient(create_app(settings)) as c:
        signup(c)
        r = c.post("/api/pay", json={"plan": "quarterly"})
        assert r.json()["redirect_url"].endswith("/pg/StartPay/A77")
        assert (
            c.get("/pay/callback?Authority=A77&Status=OK", follow_redirects=False).headers[
                "location"
            ]
            == "/#paid"
        )
        assert amounts == [settings.plans[1].amount_rial]  # verified for the price we charge
        assert c.get("/api/me").json()["active"] is True


# --- the preview page -------------------------------------------------------------------


def test_preview_is_self_contained(sample_hunt):
    page = build_preview(sample_hunt)
    assert "window.HUNTER_DEMO" in page
    assert "/static/" not in page and "@font-face" not in page
    data = page.split("window.HUNTER_DEMO = ", 1)[1].split(";</script>", 1)[0]
    assert "</script" not in data
    demo = json.loads(data)
    assert demo["hunt"]["candidates"] and demo["picks"]["candidates"]
    assert demo["me"]["active"] is True


# --- product links sellers send -----------------------------------------------------------


class CountingHunter(Hunter):
    """The sample hunter, counting the links it really had to analyse (API calls)."""

    def __init__(self):
        sample = SampleData()
        super().__init__([sample], sample)
        self.analysed = []

    def analyze_url(self, url):
        self.analysed.append(url)
        return super().analyze_url(url)


@pytest.fixture
def link_settings(tmp_path):
    """A site whose link analysis runs on the sample data, with no hunt stored yet (so
    nothing is cached)."""
    return Settings(
        db_path=str(tmp_path / "links.db"),
        gateway=DemoGateway(),
        public_url="http://testserver",
        link_hunter=CountingHunter(),
        monthly_links=5,
    )


def test_sellers_send_links_and_get_full_analyses(link_settings):
    with TestClient(create_app(link_settings)) as c:
        cfg = c.get("/api/config").json()
        assert cfg["links"] is True and len(cfg["example_links"]) == 4
        assert cfg["monthly_links"] == 5
        signup(c)
        assert c.post("/api/analyses", json={"urls": cfg["example_links"][:1]}).status_code == 402
        subscribe(c)
        urls = cfg["example_links"][:2] + ["https://www.temu.com/nope.html", "not a link"]
        r = c.post("/api/analyses", json={"urls": urls})
        assert r.status_code == 200 and r.json() == {"queued": 3, "left": 2}
        items = c.get("/api/analyses").json()["items"]
        assert [i["status"] for i in items] == ["failed", "done", "done"]  # newest first
        assert items[0]["error"] == "listing_not_found"
        found = items[2]["result"]
        assert found["offer"]["shop_name"] and found["pricing"]["amazon_usd"]
        assert {m["source"] for m in found["matches"]} == {"amazon"}
        assert not found.get("from_cache")
        more = ["https://www.temu.com/a", "https://www.temu.com/b", "https://www.temu.com/c"]
        r = c.post("/api/analyses", json={"urls": more})
        assert r.status_code == 429 and r.json()["detail"] == "monthly_limit"
        assert c.post("/api/analyses", json={"urls": ["nothing here"]}).status_code == 422


def test_a_product_is_only_analysed_once(link_settings):
    hunter = link_settings.link_hunter
    link_settings.monthly_links = 10
    with TestClient(create_app(link_settings)) as c:
        signup(c)
        subscribe(c)
        temu = next(x.url for x in hunter.markets[0].listings if x.id == "s-cat-perch")
        amazon = hunter.markets[0].amazon["s-cat-perch"].url  # the same product on Amazon
        c.post("/api/analyses", json={"urls": [temu]})
        c.post("/api/analyses", json={"urls": [temu, amazon]})
        items = c.get("/api/analyses").json()["items"]
        assert hunter.analysed == [temu]  # one real analysis, two answers from the cache
        assert [bool(i["result"].get("from_cache")) for i in items] == [True, True, False]
        assert items[0]["result"]["offer"]["id"] == items[2]["result"]["offer"]["id"]


def test_links_in_the_daily_hunt_cost_nothing(link_settings, sample_hunt):
    Database(link_settings.db_path).save_hunt(sample_hunt)
    hunter = link_settings.link_hunter
    with TestClient(create_app(link_settings)) as c:
        signup(c)
        subscribe(c)
        links = c.get("/api/config").json()["example_links"]
        c.post("/api/analyses", json={"urls": links})
        items = c.get("/api/analyses").json()["items"]
        assert hunter.analysed == []
        assert all(i["status"] == "done" and i["result"]["from_cache"] for i in items)


def test_old_cache_entries_are_analysed_again(link_settings):
    link_settings.cache_hours = 0
    hunter = link_settings.link_hunter
    with TestClient(create_app(link_settings)) as c:
        signup(c)
        subscribe(c)
        url = c.get("/api/config").json()["example_links"][0]
        c.post("/api/analyses", json={"urls": [url]})
        c.post("/api/analyses", json={"urls": [url]})
        assert hunter.analysed == [url, url]


def test_the_quota_counts_the_last_30_days(link_settings):
    db = Database(link_settings.db_path)
    with TestClient(create_app(link_settings)) as c:
        me = signup(c)
        subscribe(c)
        ids = db.queue_analyses(me["id"], ["https://www.temu.com/old"] * 5)
        with db.tx() as conn:  # sent 31 days ago: no longer counted
            conn.execute(
                "UPDATE analyses SET created_at = '2000-01-01T00:00:00+00:00' WHERE id IN (?, ?)",
                ids[:2],
            )
        assert c.get("/api/analyses").json()["left"] == 2


def test_analysed_links_get_persian_names(link_settings):
    class Namer:
        calls = []

        def translate(self, titles):
            self.calls.append(titles)
            return {k: "نام فارسی" for k in titles}

    hunter = link_settings.link_hunter
    # A product without a Persian name, as live data would be.
    for x in hunter.markets[0].listings + list(hunter.markets[0].amazon.values()):
        x.title_fa = ""
    link_settings.namer = Namer()
    with TestClient(create_app(link_settings)) as c:
        signup(c)
        subscribe(c)
        urls = c.get("/api/config").json()["example_links"][:2]
        c.post("/api/analyses", json={"urls": urls})
        items = c.get("/api/analyses").json()["items"]
        assert [i["result"]["title_fa"] for i in items] == ["نام فارسی", "نام فارسی"]
        assert len(Namer.calls) == 2 and all(len(t) == 1 for t in Namer.calls)


def test_links_are_off_without_sources(client):
    signup(client)
    subscribe(client)
    assert client.get("/api/config").json()["links"] is False
    r = client.post("/api/analyses", json={"urls": ["https://www.temu.com/x"]})
    assert r.status_code == 503 and r.json()["detail"] == "links_not_configured"


def test_too_many_links_at_once(link_settings):
    link_settings.monthly_links = 100
    with TestClient(create_app(link_settings)) as c:
        signup(c)
        subscribe(c)
        urls = [f"https://www.temu.com/{i}" for i in range(11)]
        assert c.post("/api/analyses", json={"urls": urls}).json()["detail"] == "too_many_links"


def test_links_left_waiting_by_a_restart_are_failed(link_settings):
    db = Database(link_settings.db_path)
    user_id = db.create_user("x@y.co", "x", "", "hash")
    db.queue_analyses(user_id, ["https://www.temu.com/1"])
    TestClient(create_app(link_settings))  # the app starting up
    [item] = db.analyses(user_id)
    assert (item["status"], item["error"]) == ("failed", "interrupted")


def test_manual_analysis_compares_with_amazon(client):
    signup(client)
    subscribe(client)
    a = client.post(
        "/api/analyze",
        json={
            "title": "Car Seat Gap Filler 2 Pack",
            "price_cny": 6.65,
            "weight_kg": 0.4,
            "temu_price_usd": 11.99,
            "amazon_price_usd": 16.99,
            "listing_pack": 2,
        },
    ).json()
    assert a["pricing"]["amazon_usd"] == 16.99 and a["pricing"]["vs_amazon"] < 0.7
