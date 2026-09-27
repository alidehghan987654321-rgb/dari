"""The sellers' website: sign up, pay for a subscription, then see the hunts,
get products of your own and analyse any product.

    python -m hunter serve
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.datastructures import MutableHeaders

from . import auth
from .allocate import choose_picks
from .categories import CATEGORIES, classify, pack_qty
from .db import Database, is_active
from .engine import Hunter
from .jobs import daily_hunt
from .links import link_key
from .models import MarketListing, SupplierOffer
from .payments import DemoGateway, Gateway, PaymentError, Plan, Zarinpal, make_plans
from .pricing import PricingConfig, Unprofitable, price_product
from .scoring import assess
from .sources.base import LinkError
from .sources.sample import SampleData
from .offers import offer_view
from .translate import PersianNamer, name_candidates
from .wiring import link_hunter

log = logging.getLogger(__name__)

STATIC = Path(__file__).resolve().parent / "static"
COOKIE = "hunter_session"
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
LINK = re.compile(r"^https?://\S+$")
ASSETS = ("app.css", "calc.js", "app.js")  # versioned in the page so a deploy isn't cached
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';"
        " script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none';"
        " base-uri 'self'; form-action 'self'"
    ),
}
IMAGE_HOSTS = ("alicdn.com", "1688.com", "media-amazon.com", "ssl-images-amazon.com", "kwcdn.com")


@dataclass
class Settings:
    db_path: str = "hunter-data/hunter.db"
    public_url: str = "http://localhost:8100"  # where the site is reached; for the payment callback
    brand: str = "شکارچی"
    gateway: Gateway | None = None  # None: no online payment, an admin activates sellers
    toman_per_usd: float = 234_500  # the free-market rate; plan prices and the calculator
    plans: list[Plan] = field(default_factory=lambda: make_plans(234_500))
    pricing: PricingConfig = field(default_factory=PricingConfig)
    per_product: int = 3  # sellers per product
    picks_per_seller: int = 8
    teaser_size: int = 3
    link_hunter: Hunter | None = None  # analyses the product links sellers paste
    monthly_links: int = 30  # analyses per 30 days for a seller without a plan (e.g. granted)
    links_per_request: int = 10
    cache_hours: float = 72  # a product analysed this recently is answered from the cache
    offer_cache_hours: float = 24 * 7  # 1688 offer pages shown on the site
    image_client: httpx.Client | None = None  # for the image proxy (tests pass a fake)
    namer: PersianNamer | None = None  # Persian product names with Claude
    cron_secret: str = ""  # lets a scheduler start the daily hunt (POST /internal/hunt)
    admins: tuple[str, ...] = ()  # these emails are admins as soon as they sign up or log in

    @property
    def secure_cookies(self) -> bool:
        return self.public_url.startswith("https://")

    @classmethod
    def from_env(cls) -> Settings:
        env = os.environ.get
        gateway: Gateway | None = None
        mode = env("HUNTER_PAYMENT", "zarinpal")
        if mode == "demo":
            gateway = DemoGateway()
        elif env("ZARINPAL_MERCHANT_ID"):
            gateway = Zarinpal(env("ZARINPAL_MERCHANT_ID"), sandbox=env("ZARINPAL_SANDBOX") == "1")
        toman_per_usd = float(env("HUNTER_TOMAN_PER_USD", "234500"))
        return cls(
            db_path=env("HUNTER_DB", cls.db_path),
            public_url=env("HUNTER_PUBLIC_URL", cls.public_url).rstrip("/"),
            brand=env("HUNTER_BRAND", cls.brand),
            gateway=gateway,
            toman_per_usd=toman_per_usd,
            plans=make_plans(
                toman_per_usd, json.loads(env("HUNTER_PLANS")) if env("HUNTER_PLANS") else None
            ),
            pricing=PricingConfig.from_env(),
            per_product=int(env("HUNTER_SELLERS_PER_PRODUCT", "3")),
            link_hunter=link_hunter(),
            monthly_links=int(env("HUNTER_MONTHLY_LINKS", "30")),
            cache_hours=float(env("HUNTER_CACHE_HOURS", "72")),
            namer=PersianNamer.from_env(),
            cron_secret=env("HUNTER_CRON_SECRET", ""),
            admins=tuple(
                e.strip().lower() for e in env("HUNTER_ADMINS", "").split(",") if e.strip()
            ),
        )


# --- request bodies --------------------------------------------------------------


class Signup(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    email: str = Field(max_length=120)
    phone: str = Field(default="", max_length=20)
    password: str = Field(min_length=8, max_length=200)


class Login(BaseModel):
    email: str = Field(max_length=120)
    password: str = Field(max_length=200)


class Profile(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    phone: str = Field(default="", max_length=20)
    categories: list[str] = Field(default_factory=list, max_length=len(CATEGORIES))
    budget_usd: float = Field(ge=0, le=10_000_000)


class Pay(BaseModel):
    plan: str


class Grant(BaseModel):
    email: str = Field(max_length=120)
    days: int = Field(default=30, ge=1, le=3650)
    plan: str | None = None


class Links(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=50)


class Analyze(BaseModel):
    title: str = Field(default="", max_length=300)
    price_cny: float = Field(gt=0, le=100_000)
    weight_kg: float = Field(gt=0, le=100)
    temu_price_usd: float | None = Field(default=None, ge=0, le=100_000)
    amazon_price_usd: float | None = Field(default=None, ge=0, le=100_000)
    listing_pack: int = Field(default=1, ge=1, le=100)
    supplier_pack: int = Field(default=1, ge=1, le=100)
    moq: int = Field(default=1, ge=1, le=100_000)
    monthly_sold: int | None = Field(default=None, ge=0)
    reviews: int | None = Field(default=None, ge=0)
    supplier_sales: int | None = Field(default=None, ge=0)
    market: str = Field(default="prepaid", pattern="^(prepaid|cod)$")
    items_per_cart: int = Field(default=3, ge=1, le=20)


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "phone": user["phone"],
        "categories": user["categories"],
        "budget_usd": user["budget_usd"],
        "paid_until": user["paid_until"],
        "plan": user.get("plan"),
        "is_admin": bool(user["is_admin"]),
        "active": is_active(user),
    }


def teaser(candidate: dict[str, Any]) -> dict[str, Any]:
    """What a visitor without a subscription sees of a find: that it exists, not how to
    buy it."""
    return {
        "id": candidate["id"],
        "category": candidate["category"],
        "title_fa": candidate["title_fa"],
        "verdict": candidate["verdict"],
        "score": candidate["score"],
        "locked": True,
    }


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    db = Database(settings.db_path)
    db.fail_unfinished_analyses()
    throttle = auth.Throttle()
    app = FastAPI(title=settings.brand, docs_url=None, redoc_url=None)
    headers = dict(SECURITY_HEADERS)
    if settings.secure_cookies:
        headers["Strict-Transport-Security"] = "max-age=31536000"
    app.add_middleware(SecurityHeaders, headers=headers)
    page = (STATIC / "index.html").read_text(encoding="utf-8").replace("{{v}}", asset_version())
    image_client = settings.image_client or httpx.Client(timeout=20, follow_redirects=False)
    app.state.settings = settings
    app.state.db = db

    def set_session(response: Response, user_id: int) -> None:
        token = auth.new_token()
        db.create_session(token, user_id)
        response.set_cookie(
            COOKIE,
            token,
            max_age=30 * 86400,
            httponly=True,
            samesite="lax",
            secure=settings.secure_cookies,
        )

    def current_user(request: Request) -> dict[str, Any] | None:
        token = request.cookies.get(COOKIE)
        return db.session_user(token) if token else None

    def require_user(user=Depends(current_user)) -> dict[str, Any]:
        if not user:
            raise HTTPException(401, "not_logged_in")
        return user

    def require_active(user=Depends(require_user)) -> dict[str, Any]:
        if not is_active(user):
            raise HTTPException(402, "subscription_required")
        return user

    def admin_by_setting(user: dict[str, Any]) -> dict[str, Any]:
        """HUNTER_ADMINS: where there's no shell to run make-admin (Cloudflare)."""
        if user["email"] in settings.admins and not user["is_admin"]:
            db.make_admin(user["email"])
            user = db.user(user["id"])
        return user

    # --- pages -----------------------------------------------------------------

    @app.get("/", include_in_schema=False)
    def index():
        return HTMLResponse(page, headers={"Cache-Control": "no-cache"})

    @app.post("/api/admin/grant")
    def admin_grant(body: Grant, user=Depends(require_user)):
        """An admin activates a seller who paid another way (grant, from the site)."""
        if not user["is_admin"]:
            raise HTTPException(403, "admins_only")
        if body.plan and body.plan not in {p.id for p in settings.plans}:
            raise HTTPException(422, "bad_plan")
        email = body.email.strip().lower()
        until = db.grant(email, body.days, body.plan)
        if not until:
            raise HTTPException(404, "no_such_seller")
        return {"email": email, "paid_until": until}

    @app.post("/internal/hunt", include_in_schema=False)
    def internal_hunt(request: Request, background: BackgroundTasks):
        """The daily hunt, for a scheduler that can't run a command (Cloudflare's cron
        trigger). Unknown to anyone without the secret."""
        given = request.headers.get("x-hunter-cron", "")
        if not settings.cron_secret or not hmac.compare_digest(
            given.encode(), settings.cron_secret.encode()
        ):
            raise HTTPException(404, "Not Found")
        background.add_task(lambda: log.info("daily hunt: %s", daily_hunt(db, settings.pricing)))
        return {"started": True}

    @app.get("/healthz", include_in_schema=False)
    def healthz():
        latest = db.latest_hunt_time()
        return {"ok": True, "last_hunt": latest}

    # --- config & account --------------------------------------------------------

    @app.get("/api/config")
    def config():
        latest = db.latest_hunt()
        return {
            "brand": settings.brand,
            "online_payment": settings.gateway is not None,
            "plans": [asdict(p) for p in settings.plans],
            "categories": [
                {"key": c.key, "fa": c.fa, "restricted": c.restricted, "note_fa": c.note_fa}
                for c in CATEGORIES.values()
            ],
            "hunt": (
                {"started_at": latest[1]["started_at"], "sample": latest[1].get("sample", False)}
                if latest
                else None
            ),
            "pricing": pricing_settings(settings.pricing),
            "toman_per_usd": settings.toman_per_usd,
            "per_product": settings.per_product,
            "links": settings.link_hunter is not None,
            "links_per_request": settings.links_per_request,
            "monthly_links": settings.monthly_links,
            "example_links": example_links(settings.link_hunter),
        }

    @app.post("/api/signup")
    def signup(body: Signup, response: Response):
        email = body.email.strip().lower()
        if not EMAIL.match(email):
            raise HTTPException(422, "bad_email")
        if db.user_by_email(email):
            raise HTTPException(409, "email_taken")
        user_id = db.create_user(
            email, body.name.strip(), body.phone.strip(), auth.hash_password(body.password)
        )
        set_session(response, user_id)
        return public_user(admin_by_setting(db.user(user_id)))

    @app.post("/api/login")
    def login(body: Login, request: Request, response: Response):
        email = body.email.strip().lower()
        key = f"{request.client.host if request.client else ''}|{email}"
        if throttle.blocked(key):
            raise HTTPException(429, "too_many_attempts")
        user = db.user_by_email(email)
        if not user or not auth.check_password(body.password, user["password_hash"]):
            throttle.fail(key)
            raise HTTPException(401, "wrong_login")
        throttle.reset(key)
        set_session(response, user["id"])
        return public_user(admin_by_setting(user))

    @app.post("/api/logout")
    def logout(request: Request, response: Response):
        token = request.cookies.get(COOKIE)
        if token:
            db.delete_session(token)
        response.delete_cookie(COOKIE)
        return {"ok": True}

    @app.get("/api/me")
    def me(user=Depends(require_user)):
        return public_user(user)

    @app.put("/api/me")
    def update_me(body: Profile, user=Depends(require_user)):
        cats = [c for c in dict.fromkeys(body.categories) if c in CATEGORIES]
        db.update_profile(
            user["id"],
            name=body.name.strip(),
            phone=body.phone.strip(),
            categories=cats,
            budget_usd=body.budget_usd,
        )
        return public_user(db.user(user["id"]))

    # --- payment -----------------------------------------------------------------

    @app.post("/api/pay")
    def pay(body: Pay, user=Depends(require_user)):
        plan = next((p for p in settings.plans if p.id == body.plan), None)
        if plan is None:
            raise HTTPException(404, "unknown_plan")
        if settings.gateway is None:
            raise HTTPException(503, "no_online_payment")
        payment_id = db.create_payment(
            user["id"], plan.id, plan.days, plan.amount_rial, settings.gateway.name
        )
        try:
            authority, url = settings.gateway.start(
                plan.amount_rial,
                f"{settings.brand} - {plan.name_fa}",
                f"{settings.public_url}/pay/callback",
                user["email"],
                user["phone"],
            )
        except (PaymentError, OSError) as e:
            log.warning("Payment start failed: %s", e)
            raise HTTPException(502, "gateway_error") from None
        db.set_authority(payment_id, authority)
        return {"redirect_url": url}

    @app.get("/pay/callback", include_in_schema=False)
    def pay_callback(Authority: str = "", Status: str = ""):  # noqa: N803 (Zarinpal's names)
        payment = db.payment_by_authority(Authority) if Authority else None
        if not payment or settings.gateway is None:
            return RedirectResponse("/#pay-failed", status_code=303)
        if payment["status"] == "paid":
            return RedirectResponse("/#paid", status_code=303)
        if Status != "OK":
            db.mark_failed(payment["id"])
            return RedirectResponse("/#pay-cancelled", status_code=303)
        ref = settings.gateway.verify(Authority, payment["amount_rial"])
        if not ref:
            db.mark_failed(payment["id"])
            return RedirectResponse("/#pay-failed", status_code=303)
        db.mark_paid(payment["id"], ref)
        return RedirectResponse("/#paid", status_code=303)

    # --- hunts -------------------------------------------------------------------

    def latest_or_404() -> tuple[int, dict]:
        latest = db.latest_hunt()
        if not latest:
            raise HTTPException(404, "no_hunt_yet")
        return latest

    @app.get("/api/hunt")
    def hunt(user=Depends(current_user)):
        hunt_id, data = latest_or_404()
        candidates = data["candidates"]
        counts: dict[str, int] = {}
        for c in candidates:
            counts[c["verdict"]] = counts.get(c["verdict"], 0) + 1
        head = {
            "id": hunt_id,
            "started_at": data["started_at"],
            "sample": data.get("sample", False),
            "note": data.get("note", ""),
            "counts": counts,
        }
        if user and is_active(user):
            return {**head, "locked": False, "candidates": candidates}
        best = [c for c in candidates if c["verdict"] == "green"][: settings.teaser_size]
        return {**head, "locked": True, "candidates": [teaser(c) for c in best]}

    @app.get("/api/picks")
    def picks(user=Depends(require_active)):
        hunt_id, data = latest_or_404()
        by_id = {c["id"]: c for c in data["candidates"]}
        ids = db.picks(hunt_id, user["id"])
        if not ids:
            with db.picking(hunt_id) as (taken, save):
                ids = choose_picks(
                    data["candidates"],
                    user["categories"],
                    user["budget_usd"],
                    taken,
                    per_product=settings.per_product,
                    max_picks=settings.picks_per_seller,
                )
                save(user["id"], ids)
        chosen = [by_id[i] for i in ids if i in by_id]
        return {
            "hunt_id": hunt_id,
            "budget_usd": user["budget_usd"],
            "capital_usd": round(sum(c["starter_capital_usd"] for c in chosen), 2),
            "per_product": settings.per_product,
            "candidates": chosen,
        }

    @app.post("/api/analyze")
    def analyze(body: Analyze, user=Depends(require_active)):
        cfg = replace(settings.pricing.for_market(body.market), items_per_cart=body.items_per_cart)
        title = body.title.strip() or "محصول"
        category = classify(title)
        units = max(1, round(body.listing_pack / body.supplier_pack))
        weight = body.weight_kg
        listing = MarketListing(
            source="temu",
            id="analyze",
            title=title,
            url="",
            image_url="",
            price_usd=body.temu_price_usd or 0,
            category=category,
            monthly_sold=body.monthly_sold,
            reviews=body.reviews,
            weight_kg=weight,
        )
        offer = SupplierOffer(
            id="analyze",
            title="",
            url="",
            image_url="",
            price_cny=body.price_cny,
            moq=body.moq,
            sales=body.supplier_sales,
        )
        temu, amazon = body.temu_price_usd or None, body.amazon_price_usd or None
        # Only an Amazon price: priced against the Temu price it suggests, as in the hunt.
        benchmark = temu or (amazon * cfg.temu_vs_amazon if amazon else None)
        try:
            pricing = price_product(
                body.price_cny,
                weight,
                benchmark,
                cfg,
                benchmark_estimated=not temu and bool(amazon),
                units=units,
                amazon_usd=amazon,
            )
        except Unprofitable as e:
            raise HTTPException(422, str(e)) from None
        a = assess(listing, offer, pricing, weight, cfg.max_premium)
        starter = max(body.moq, cfg.min_starter_qty)
        return {
            "id": "analyze",
            "category": category,
            "title_fa": title,
            "listing": asdict(listing),
            "offer": asdict(offer),
            "pack_qty": units,
            "weight_kg": weight,
            "pricing": asdict(pricing),
            "score": a.score,
            "verdict": a.verdict,
            "pros": a.pros,
            "cons": a.cons,
            "flags": a.flags,
            "starter_qty": starter,
            "starter_capital_usd": round(starter * pricing.landed_usd, 2),
            "detected_pack": pack_qty(title),
        }

    # --- product links sellers bring ------------------------------------------------

    def run_analyses(jobs: list[tuple[int, str]]) -> None:
        hunter = settings.link_hunter
        for analysis_id, url in jobs:
            key = link_key(url)
            cached = db.cached(key, settings.cache_hours)
            if cached is not None:  # seen recently, maybe in the daily hunt: no API calls
                db.set_analysis(analysis_id, "done", result={**cached, "from_cache": True})
                continue
            db.set_analysis(analysis_id, "running")
            try:
                result = hunter.analyze_url(url).to_dict()
            except LinkError as e:
                db.set_analysis(analysis_id, "failed", error=str(e))
                continue
            except Exception:
                log.exception("Analysis of %s failed", url)
                db.set_analysis(analysis_id, "failed", error="analysis_error")
                continue
            name_candidates([result], settings.namer, db)
            urls = [url, result["listing"]["url"], *(m["url"] for m in result["matches"])]
            db.cache([link_key(u) for u in urls if u], result)
            db.set_analysis(analysis_id, "done", result=result)

    def quota(user: dict[str, Any]) -> int:
        plan = next((p for p in settings.plans if p.id == user.get("plan")), None)
        return plan.links if plan else settings.monthly_links

    def links_left(user: dict[str, Any]) -> int:
        return max(0, quota(user) - db.analyses_since(user["id"], 30))

    @app.post("/api/analyses")
    def send_links(body: Links, background: BackgroundTasks, user=Depends(require_active)):
        if settings.link_hunter is None:
            raise HTTPException(503, "links_not_configured")
        urls = list(dict.fromkeys(u.strip() for u in body.urls if LINK.match(u.strip())))
        if not urls:
            raise HTTPException(422, "no_links")
        if len(urls) > settings.links_per_request:
            raise HTTPException(422, "too_many_links")
        if len(urls) > links_left(user):
            raise HTTPException(429, "monthly_limit")
        ids = db.queue_analyses(user["id"], urls)
        background.add_task(run_analyses, list(zip(ids, urls)))
        return {"queued": len(ids), "left": links_left(user)}

    @app.get("/api/analyses")
    def my_analyses(user=Depends(require_active)):
        return {"items": db.analyses(user["id"]), "left": links_left(user), "quota": quota(user)}

    # --- a 1688 offer shown on our site ------------------------------------------

    def known_offer_urls(user: dict[str, Any]) -> set[str]:
        """Offers the site itself found for this seller: only these are fetched, so
        nobody can make us pay for looking up arbitrary pages."""
        found = []
        latest = db.latest_hunt()
        if latest:
            found += latest[1]["candidates"]
        found += [a["result"] for a in db.analyses(user["id"], 200) if a["result"]]
        return {o["url"] for c in found for o in [c["offer"], *c.get("alternatives", [])]}

    @app.get("/api/offer")
    def offer(url: str, user=Depends(require_active)):
        supplier = settings.link_hunter.supplier if settings.link_hunter else None
        if supplier is None or not hasattr(supplier, "offer_detail"):
            raise HTTPException(503, "details_not_configured")
        if url not in known_offer_urls(user):
            raise HTTPException(404, "offer_not_found")
        cached = db.cached_offer(url, settings.offer_cache_hours)
        if cached is not None:
            return cached
        try:
            detail = supplier.offer_detail(url)
        except LinkError as e:
            raise HTTPException(503, str(e)) from None
        except Exception:
            log.exception("Reading 1688 offer %s failed", url)
            raise HTTPException(502, "offer_error") from None
        if detail is None:
            raise HTTPException(404, "offer_not_found")
        view = offer_view(detail, settings.namer, db)
        db.cache_offer(url, view)
        return view

    @app.get("/img", include_in_schema=False)
    def image(u: str, user=Depends(require_user)):
        """Product pictures through our server: Amazon's, Temu's and 1688's image hosts
        are often unreachable from Iran. Only those hosts, only images."""
        parts = urlsplit(u)
        host = (parts.hostname or "").lower()
        if parts.scheme != "https" or not any(
            host == h or host.endswith("." + h) for h in IMAGE_HOSTS
        ):
            raise HTTPException(400, "not_an_image_host")
        try:
            r = image_client.get(u)
        except httpx.HTTPError:
            raise HTTPException(502, "image_error") from None
        kind = r.headers.get("content-type", "")
        if r.status_code != 200 or not kind.startswith("image/") or len(r.content) > 8_000_000:
            raise HTTPException(502, "image_error")
        return Response(
            r.content, media_type=kind, headers={"Cache-Control": "private, max-age=604800"}
        )

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


class SecurityHeaders:
    """Adds the security headers to every response (plain ASGI, so background tasks and
    streaming are untouched)."""

    def __init__(self, app, headers: dict[str, str]):
        self.app, self.headers = app, headers

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                for k, v in self.headers.items():
                    if k not in h:
                        h[k] = v
            await send(message)

        await self.app(scope, receive, send_with_headers)


def asset_version() -> str:
    digest = hashlib.sha256()
    for name in ASSETS:
        digest.update((STATIC / name).read_bytes())
    return digest.hexdigest()[:10]


def example_links(hunter: Hunter | None) -> list[str]:
    """With the sample data behind the link analysis, a few links it knows, to try."""
    sample = next(
        (m for m in (hunter.markets if hunter else []) if isinstance(m, SampleData)), None
    )
    if not sample:
        return []
    return [sample.listings[i].url for i in (0, 8, 2)] + [sample.amazon["s-packing-cubes"].url]


def pricing_settings(cfg: PricingConfig) -> dict[str, Any]:
    """The pricing assumptions, for the page to show (JSON has no infinity)."""
    d = asdict(cfg)
    d["last_mile_usd"] = [
        [None if kg == float("inf") else kg, cost] for kg, cost in cfg.last_mile_usd
    ]
    return d
