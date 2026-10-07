"""The ways sites built with AI were broken into in 2025-2026, each closed and kept closed:
admin by email, cross-site requests, guessing passwords, stolen sessions, server-side
requests to other hosts, formulas in exported sheets, oversized requests, free payments."""

import hashlib
import io
import sqlite3
import zipfile

import httpx
import pytest
from fastapi.testclient import TestClient

from hunter import auth
from hunter.app import MAX_BODY, SECURE_COOKIE, Settings, create_app
from hunter.db import Database
from hunter.export import _csv, build_order
from hunter.media import IMAGE_HOSTS, MAX_IMAGE, allowed
from hunter.payments import DemoGateway

PASSWORD = "secret-pass"
CODE = "a-long-admin-code-for-the-tests-only"


@pytest.fixture
def settings(tmp_path):
    return Settings(
        db_path=str(tmp_path / "s.db"), gateway=DemoGateway(), public_url="http://testserver"
    )


def signup(client, email="seller@example.com", **headers):
    body = {"name": "فروشنده", "email": email, "phone": "", "password": PASSWORD}
    return client.post("/api/signup", json=body, headers=headers)


def login(client, email="seller@example.com", password=PASSWORD):
    return client.post("/api/login", json={"email": email, "password": password})


# --- admin rights ---------------------------------------------------------------------


def test_an_email_alone_never_makes_an_admin(settings):
    """The support email is printed on the site: signing up with it (or with one listed in
    HUNTER_ADMINS) used to make anyone an admin."""
    settings.admins = ("boss@example.com",)
    with TestClient(create_app(settings)) as c:
        for email in ("afran.persianmall@gmail.com", "boss@example.com"):
            me = signup(c, email).json()
            assert me["is_admin"] is False and me["can_claim_admin"] is False  # no token set
            assert c.get("/api/admin/pricing").status_code == 403
            assert c.post("/api/admin/claim", json={"code": "x"}).status_code == 404
            c.post("/api/logout")
            assert login(c, email).json()["is_admin"] is False


def test_admin_code_is_checked_and_guessing_it_is_stopped(settings):
    settings.admins, settings.admin_token = ("boss@example.com",), CODE
    with TestClient(create_app(settings)) as c:
        signup(c, "boss@example.com")
        for _ in range(5):
            assert c.post("/api/admin/claim", json={"code": "guess"}).status_code == 403
        # Blocked now, even with the right code.
        assert c.post("/api/admin/claim", json={"code": CODE}).status_code == 429
    with TestClient(create_app(settings)) as c:  # a new app: the counter starts again
        login(c, "boss@example.com")
        old = c.cookies.get("hunter_session")
        r = c.post("/api/admin/claim", json={"code": CODE})
        assert r.status_code == 200 and r.json()["is_admin"] is True
        assert c.cookies.get("hunter_session") != old  # a new session for the new rights
        assert Database(settings.db_path).session_user(old) is None


def test_openapi_schema_is_not_published(settings):
    with TestClient(create_app(settings)) as c:
        for path in ("/openapi.json", "/docs", "/redoc"):
            assert c.get(path).status_code == 404


# --- sessions and cookies -----------------------------------------------------------------


def test_sessions_are_kept_hashed(settings):
    with TestClient(create_app(settings)) as c:
        signup(c)
        token = c.cookies.get("hunter_session")
        assert token and c.get("/api/me").status_code == 200
    with sqlite3.connect(settings.db_path) as db:
        stored = [r[0] for r in db.execute("SELECT token FROM sessions")]
    assert stored == [hashlib.sha256(token.encode()).hexdigest()]  # a leaked copy can't log in


def test_old_plaintext_sessions_are_dropped(settings):
    db = Database(settings.db_path)
    user_id = db.create_user("a@example.com", "a", "", auth.hash_password(PASSWORD))
    with sqlite3.connect(settings.db_path) as conn:  # a session from before hashing
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?, ?)", ("plain-old-token", user_id, "2999-01-01")
        )
    Database(settings.db_path)
    with sqlite3.connect(settings.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


def test_https_cookie_is_host_only_and_secure(settings):
    settings.public_url = "https://testserver"
    with TestClient(create_app(settings), base_url="https://testserver") as c:
        r = signup(c)
        cookie = r.headers["set-cookie"]
        assert cookie.startswith(SECURE_COOKIE + "=")
        for part in ("HttpOnly", "Secure", "Path=/", "SameSite=lax"):
            assert part in cookie
        assert "Domain" not in cookie
        assert c.get("/api/me").status_code == 200
        assert "max-age=63072000" in r.headers["strict-transport-security"]
        out = c.post("/api/logout").headers["set-cookie"]
        assert out.startswith(SECURE_COOKIE + '=""') and "Secure" in out
        assert c.get("/api/me").status_code == 401


# --- passwords and logins -----------------------------------------------------------------


def test_login_limits_per_address_and_per_email(settings):
    with TestClient(create_app(settings)) as c:
        signup(c)
        c.post("/api/logout")
        for i in range(30):  # one address trying many emails (credential stuffing)
            assert login(c, f"x{i}@example.com", "wrong-pass").status_code == 401
        assert login(c).status_code == 429  # even the right password, from this address
    with TestClient(create_app(settings)) as c:
        for _ in range(8):
            assert login(c, password="wrong-pass").status_code == 401
        assert login(c).status_code == 429


def test_unknown_email_costs_a_password_check(settings, monkeypatch):
    """Otherwise a fast "wrong" tells an attacker which emails have accounts."""
    checked = []
    real = auth.check_password
    monkeypatch.setattr(auth, "check_password", lambda p, h: checked.append(h) or real(p, h))
    with TestClient(create_app(settings)) as c:
        assert login(c, "nobody@example.com").status_code == 401
    assert checked == [auth.dummy_hash()]


def test_weak_old_hashes_are_upgraded_on_login(settings, monkeypatch):
    monkeypatch.setattr(auth, "P", 1)
    old = auth.hash_password(PASSWORD)
    monkeypatch.undo()
    assert auth.needs_rehash(old) and not auth.needs_rehash(auth.hash_password("x" * 8))
    Database(settings.db_path).create_user("a@example.com", "a", "", old)
    with TestClient(create_app(settings)) as c:
        assert login(c, "a@example.com").status_code == 200
    new = Database(settings.db_path).user_by_email("a@example.com")["password_hash"]
    assert new != old and new.split("$")[1:4] == [str(auth.N), str(auth.R), str(auth.P)]
    assert auth.check_password(PASSWORD, new)


def test_stored_hash_cant_ask_for_unbounded_work():
    assert not auth.check_password("x", "scrypt$1073741824$8$1$AAAA$AAAA")
    assert not auth.check_password("x", "not-a-hash")


def test_signups_per_address_are_limited(settings):
    with TestClient(create_app(settings)) as c:
        for i in range(15):
            assert signup(c, f"s{i}@example.com").status_code == 200
        for _ in range(5):  # trying emails that have accounts counts too
            assert signup(c, "s0@example.com").status_code == 409
        assert signup(c, "new@example.com").status_code == 429


def test_password_cant_be_the_email(settings):
    with TestClient(create_app(settings)) as c:
        body = {"name": "aa", "email": "longname@x.io", "password": "longname@x.io"}
        assert c.post("/api/signup", json=body).json()["detail"] == "weak_password"


def test_throttle_memory_is_bounded():
    t = auth.Throttle(limit=3, window=600)
    t.MAX_KEYS = 50
    for i in range(500):
        t.fail(f"k{i}")
    assert len(t.failures) <= 50
    assert not t.blocked("never-seen") and "never-seen" not in t.failures


# --- requests from other sites ------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "https://evil.example"},
        {"Origin": "null"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site", "Origin": "https://bookfin.gryffin.uk"},  # a sibling
    ],
)
def test_changes_from_other_sites_are_refused(settings, headers):
    with TestClient(create_app(settings)) as c:
        assert signup(c).status_code == 200
        r = c.put(
            "/api/me",
            json={"name": "hacked", "phone": "", "categories": [], "budget_usd": 1},
            headers=headers,
        )
        assert r.status_code == 403 and r.json()["detail"] == "cross_site_request"
        assert c.post("/api/logout", headers=headers).status_code == 403
        assert c.get("/api/me").json()["name"] == "فروشنده"


def test_same_origin_requests_go_through(settings):
    with TestClient(create_app(settings)) as c:
        same = {"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"}
        assert signup(c, **same).status_code == 200
        assert c.post("/api/logout", headers=same).status_code == 200
        assert c.get("/api/config", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 200


# --- request size, caching and headers ----------------------------------------------------


def test_oversized_bodies_are_refused(settings):
    with TestClient(create_app(settings)) as c:
        big = b'{"email": "' + b"a" * (MAX_BODY + 10) + b'"}'
        r = c.post("/api/login", content=big, headers={"Content-Type": "application/json"})
        assert r.status_code == 413

        def chunks():  # no Content-Length: counted as it arrives
            for _ in range(MAX_BODY // 1024 + 2):
                yield b" " * 1024

        r = c.post("/api/login", content=chunks(), headers={"Content-Type": "application/json"})
        assert r.status_code == 413


def test_private_data_is_not_cached_and_headers_are_set(settings):
    with TestClient(create_app(settings)) as c:
        signup(c)
        r = c.get("/api/me")
        assert r.headers["cache-control"] == "no-store"
        page = c.get("/")
        assert page.headers["cross-origin-opener-policy"] == "same-origin"
        assert page.headers["cross-origin-resource-policy"] == "same-origin"
        assert page.headers["x-frame-options"] == "DENY"
        assert "object-src 'none'" in page.headers["content-security-policy"]
        assert "frame-ancestors 'none'" in page.headers["content-security-policy"]


# --- payments ----------------------------------------------------------------------------


def test_demo_payment_is_refused_on_a_real_site(settings):
    settings.public_url = "https://hunter.example"
    with TestClient(create_app(settings), base_url="https://hunter.example") as c:
        assert c.get("/api/config").json()["online_payment"] is False
        signup(c)
        assert c.post("/api/pay", json={"plan": "pro"}).status_code == 503
    settings.allow_demo_payment = True  # only on purpose (HUNTER_ALLOW_DEMO_PAYMENT=1)
    with TestClient(create_app(settings), base_url="https://hunter.example") as c:
        assert c.get("/api/config").json()["online_payment"] is True


def test_payments_started_per_seller_are_limited(settings):
    with TestClient(create_app(settings)) as c:
        signup(c)
        for _ in range(10):
            assert c.post("/api/pay", json={"plan": "pro"}).status_code == 200
        assert c.post("/api/pay", json={"plan": "pro"}).status_code == 429


# --- what sellers type ----------------------------------------------------------------------


def test_phone_and_national_id_are_checked(settings):
    with TestClient(create_app(settings)) as c:
        signup(c)
        profile = {"name": "فروشنده", "categories": [], "budget_usd": 100}
        r = c.put(
            "/api/me", json={**profile, "phone": "۰۹۱۲ ۱۲۳ ۴۵۶۷", "national_id": "۰۰۱۲۳۴۵۶۷۸"}
        )
        assert r.status_code == 200
        assert r.json()["phone"] == "0912 123 4567" and r.json()["national_id"] == "0012345678"
        for bad in ({"phone": "=1+1"}, {"phone": "<script>"}, {"national_id": "12345"}):
            r = c.put("/api/me", json={**profile, "phone": "", **bad})
            assert r.status_code == 422


def test_cart_size_is_capped(settings, tmp_path):
    settings.max_cart = 2
    db = Database(settings.db_path)
    with TestClient(create_app(settings)) as c:
        signup(c)
        db.grant("seller@example.com", 30)
        item = {"title_fa": "x", "price_cny": 10, "weight_kg": 0.2}
        assert c.post("/api/requests", json=item).status_code == 200
        assert c.post("/api/requests", json=item).status_code == 200
        r = c.post("/api/requests", json=item)
        assert r.status_code == 409 and r.json()["detail"] == "cart_full"


def test_order_sheet_never_holds_a_formula():
    evil = '=HYPERLINK("http://evil.example","click")'
    user = {"name": "=cmd|' /C calc'!A0", "phone": "+98912", "email": "a@b.c"}
    cart = {"items": [{"title_fa": evil, "note": "@SUM(1)", "price_cny": 1}], "summary": {}}
    data, name, _ = build_order(user, cart, 255_000)
    assert name.endswith(".xlsx")
    sheet = zipfile.ZipFile(io.BytesIO(data)).read("xl/worksheets/sheet1.xml").decode()
    assert "<f>" not in sheet and "<f " not in sheet
    text = _csv([["=1+1", "-2", "@x", "+3", "ok"]], [[1, -2.5, "\tx"]], {}).decode("utf-8-sig")
    assert text.splitlines()[0] == "'=1+1,'-2,'@x,'+3,ok"
    assert "1,-2.5,'\tx" in text  # numbers stay numbers


# --- fetching pictures for sellers (SSRF) ---------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example\\@cbu01.alicdn.com/a.jpg",
        "https://user@cbu01.alicdn.com/a.jpg",
        "https://cbu01.alicdn.com:8443/a.jpg",
        "https://alicdn.com.evil.example/a.jpg",
        "https://evilalicdn.com/a.jpg",
        "https://cbu01.alicdn.com\n.evil.example/",
        "https://127.0.0.1/a.jpg",
        "https://[::1]/a.jpg",
        "http://cbu01.alicdn.com/a.jpg",
        "https://аlicdn.com/a.jpg",  # a Cyrillic "а"
        "file:///etc/passwd",
        "https://cbu01.alicdn.com/" + "a" * 3000,
    ],
)
def test_only_our_picture_hosts_are_fetched(url):
    assert not allowed(url, IMAGE_HOSTS)


def test_legit_picture_links_still_work():
    for url in ("https://cbu01.alicdn.com/img/a.jpg_640x640.jpg", "https://img.kwcdn.com/x.png"):
        assert allowed(url, IMAGE_HOSTS)


def test_picture_proxy_stops_at_the_size_limit(settings):
    sent = []

    def handler(request):
        def body():
            for _ in range(MAX_IMAGE // 65536 + 10):
                sent.append(1)
                yield b"\0" * 65536

        kind = "image/svg+xml" if request.url.path.endswith(".svg") else "image/png"
        return httpx.Response(200, headers={"content-type": kind}, content=body())

    settings.image_client = httpx.Client(transport=httpx.MockTransport(handler))
    with TestClient(create_app(settings)) as c:
        signup(c)
        r = c.get("/img", params={"u": "https://cbu01.alicdn.com/huge.png"})
        assert r.status_code == 502
        assert len(sent) <= MAX_IMAGE // 65536 + 2  # it stopped reading, not read it all
        r = c.get("/img", params={"u": "https://cbu01.alicdn.com/x.svg"})
        assert r.status_code == 502  # a picture that can carry script
        r = c.get("/img", params={"u": "https://user@cbu01.alicdn.com/a.png"})
        assert r.status_code == 400


# --- second pass: keys in logs, picture bombs, the analysis quota -------------------------


def test_api_keys_never_reach_the_log(caplog):
    import logging

    from hunter import logs

    handler = logging.StreamHandler(io.StringIO())
    logging.getLogger().addHandler(handler)
    try:
        logs.install()
        log = logging.getLogger("hunter.test")
        log.warning("GET https://api.keepa.com/product?key=SECRET1&domain=1")
        try:
            raise RuntimeError("401 for https://api.apify.com/v2/x?token=SECRET2")
        except RuntimeError:
            log.exception("failed")
        httpx_client = httpx.Client(
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))
        )
        httpx_client.get("https://api.keepa.com/product", params={"key": "SECRET3"})
        text = handler.stream.getvalue()
    finally:
        logging.getLogger().removeHandler(handler)
    assert "SECRET" not in text and "key=***" in text and "token=***" in text


def test_picture_bomb_is_refused_before_decoding():
    import struct
    import zlib

    from hunter.media import store_ready

    def chunk(kind, data):
        crc = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    # A 70-byte PNG that claims 10000x10000 pixels: under Pillow's own limit, over ours.
    header = struct.pack(">IIBBBBB", 10_000, 10_000, 8, 2, 0, 0, 0)
    bomb = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IEND", b"")
    with pytest.raises(ValueError, match="too big"):
        store_ready(bomb)


def test_analysis_quota_holds_when_requests_race(settings):
    """Counted and queued in one step: requests sent at once can't each see room left."""
    from concurrent.futures import ThreadPoolExecutor

    db = Database(settings.db_path)
    user_id = db.create_user("a@example.com", "a", "", auth.hash_password(PASSWORD))
    urls = [f"https://www.temu.com/x-g-{1000000 + i}.html" for i in range(5)]
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda _: db.queue_analyses(user_id, urls, quota=12), range(8)))
    assert sum(1 for r in results if r) == 2  # 2 x 5 = 10 fit in 12; a third wouldn't
    assert db.analyses_since(user_id) == 10


def test_huge_catalog_offset_is_not_a_crash(settings):
    with TestClient(create_app(settings)) as c:
        signup(c)
        Database(settings.db_path).grant("seller@example.com", 30)
        assert c.get("/api/catalog", params={"offset": 10**30}).status_code == 200
