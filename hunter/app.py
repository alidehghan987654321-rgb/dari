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
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
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
from .media import (
    IMAGE_HOSTS,
    MAX_IMAGE,
    MAX_VIDEO,
    VIDEO_HOSTS,
    allowed,
    collect,
    disposition,
    extension,
    file_name,
    store_ready,
    zip_images,
)
from .models import MarketListing, SupplierOffer
from .economics import Economics
from .export import build_order
from .orders import quote, quoted_cart
from .payments import DemoGateway, Gateway, PaymentError, Plan, Zarinpal, make_plans
from .pricing import RETURN_RESERVE, PricingConfig, Unprofitable, price_product
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


@dataclass
class Settings:
    db_path: str = "hunter-data/hunter.db"
    public_url: str = "http://localhost:8100"  # where the site is reached; for the payment callback
    brand: str = "شکارچی"
    gateway: Gateway | None = None  # None: no online payment, an admin activates sellers
    toman_per_usd: float = 255_000  # the free-market rate; plan prices and the calculator
    plans: list[Plan] = field(default_factory=lambda: make_plans(255_000))
    economics: Economics = field(default_factory=Economics)  # what the plans cost us; their margin
    pricing: PricingConfig = field(default_factory=PricingConfig)
    per_product: int = 3  # sellers per product
    picks_per_seller: int = 8
    teaser_size: int = 3
    link_hunter: Hunter | None = None  # analyses the product links sellers paste
    monthly_links: int = 30  # analyses per 30 days for a seller without a plan (e.g. granted)
    links_per_request: int = 10
    cache_hours: float = 24 * 7  # a product analysed this recently is answered from the cache
    offer_cache_hours: float = 24 * 14  # 1688 offer pages shown on the site
    image_client: httpx.Client | None = None  # for the image proxy (tests pass a fake)
    namer: PersianNamer | None = None  # Persian product names with Claude
    cron_secret: str = ""  # lets a scheduler start the daily hunt (POST /internal/hunt)
    admins: tuple[str, ...] = ()  # these emails are admins as soon as they sign up or log in
    # Support and the project's manager, shown on the site; their email is an admin too.
    support_name: str = "امید علی دهقان"
    support_phone: str = "09120412723"
    support_email: str = "afran.persianmall@gmail.com"

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
        toman_per_usd = float(env("HUNTER_TOMAN_PER_USD") or "255000")  # empty: the default
        economics = Economics.from_env()
        return cls(
            db_path=env("HUNTER_DB", cls.db_path),
            public_url=env("HUNTER_PUBLIC_URL", cls.public_url).rstrip("/"),
            brand=env("HUNTER_BRAND", cls.brand),
            gateway=gateway,
            toman_per_usd=toman_per_usd,
            plans=make_plans(
                toman_per_usd,
                json.loads(env("HUNTER_PLANS")) if env("HUNTER_PLANS") else None,
                economics,
            ),
            economics=economics,
            pricing=PricingConfig.from_env(),
            per_product=int(env("HUNTER_SELLERS_PER_PRODUCT", "3")),
            link_hunter=link_hunter(),
            monthly_links=int(env("HUNTER_MONTHLY_LINKS", "30")),
            cache_hours=float(env("HUNTER_CACHE_HOURS", "168")),
            offer_cache_hours=float(env("HUNTER_OFFER_CACHE_HOURS", "336")),
            namer=PersianNamer.from_env(),
            cron_secret=env("HUNTER_CRON_SECRET", ""),
            admins=tuple(
                e.strip().lower() for e in env("HUNTER_ADMINS", "").split(",") if e.strip()
            ),
            support_name=env("HUNTER_SUPPORT_NAME", cls.support_name),
            support_phone=env("HUNTER_SUPPORT_PHONE", cls.support_phone),
            support_email=env("HUNTER_SUPPORT_EMAIL", cls.support_email).strip().lower(),
        )

    @property
    def admin_emails(self) -> set[str]:
        return {*self.admins, *([self.support_email.lower()] if self.support_email else [])}


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
    national_id: str = Field(default="", max_length=20)
    categories: list[str] = Field(default_factory=list, max_length=len(CATEGORIES))
    budget_usd: float = Field(ge=0, le=10_000_000)


class OrderRequest(BaseModel):
    """One product the seller wants to order (added to the cart / ثبت درخواست)."""

    title_fa: str = Field(default="محصول", max_length=200)
    category: str = Field(default="", max_length=60)
    product_url: str = Field(default="", max_length=600)
    reference_url: str = Field(default="", max_length=600)
    keyword_en: str = Field(default="", max_length=200)
    keyword_zh: str = Field(default="", max_length=200)
    price_cny: float = Field(gt=0, le=1_000_000)
    units: int = Field(default=1, ge=1, le=1000)
    moq: int = Field(default=1, ge=1, le=1_000_000)
    weight_kg: float = Field(gt=0, le=100)
    amazon_usd: float | None = Field(default=None, ge=0, le=1_000_000)
    temu_usd: float | None = Field(default=None, ge=0, le=1_000_000)
    capital_usd: float = Field(default=0, ge=0, le=10_000_000)
    qty: int | None = Field(default=None, ge=0, le=1_000_000)
    note: str = Field(default="", max_length=500)


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
        "national_id": user.get("national_id", ""),
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
        """HUNTER_ADMINS and the support email: where there's no shell to run make-admin
        (Cloudflare)."""
        if user["email"] in settings.admin_emails and not user["is_admin"]:
            db.make_admin(user["email"])
            user = db.user(user["id"])
        return user

    # --- pages -----------------------------------------------------------------

    @app.get("/", include_in_schema=False)
    def index():
        return HTMLResponse(page, headers={"Cache-Control": "no-cache"})

    @app.get("/api/admin/pricing")
    def admin_pricing(user=Depends(require_user)):
        """For the site's admin: the costs by kind, and each plan's price, costs and margin."""
        if not user["is_admin"]:
            raise HTTPException(403, "admins_only")
        return settings.economics.report(settings.plans, settings.toman_per_usd)

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
            "support": {
                "name": settings.support_name,
                "phone": settings.support_phone,
                "email": settings.support_email,
            },
            "media": True,
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
            national_id=body.national_id.strip(),
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

    @app.get("/api/catalog")
    def catalog(
        user=Depends(require_active),
        category: str = "all",
        verdict: str = "all",
        sort: str = "new",
        fresh: bool = False,
        q: str = "",
        offset: int = 0,
        limit: int = 24,
    ):
        """The whole growing catalog, open to every subscriber: filtered, sorted, paginated."""
        page = db.catalog_page(
            category=category,
            verdict=verdict,
            sort=sort,
            fresh_hours=24 if fresh else None,
            q=q.strip()[:80],
            limit=max(1, min(60, limit)),
            offset=max(0, offset),
        )
        if offset == 0:
            page["counts"] = db.catalog_counts()
        return page

    @app.get("/api/picks")
    def picks(user=Depends(require_active)):
        """A seller's exclusive picks (option B), drawn from the catalog and capped per
        product so sellers don't all chase the same item."""
        ids = db.my_catalog_picks(user["id"])
        if not ids:
            with db.picking_catalog() as (taken, save):
                ids = choose_picks(
                    db.catalog_for_picks(user["categories"]),
                    user["categories"],
                    user["budget_usd"],
                    taken,
                    per_product=settings.per_product,
                    max_picks=settings.picks_per_seller,
                )
                save(user["id"], ids)
        chosen = db.catalog_items(ids)
        return {
            "budget_usd": user["budget_usd"],
            "capital_usd": round(sum(c.get("starter_capital_usd", 0) for c in chosen), 2),
            "per_product": settings.per_product,
            "candidates": chosen,
        }

    # --- order cart (سبد سفارش): ثبت درخواست و خروجی اکسل برای راینومال ----------

    @app.get("/api/requests")
    def list_requests(user=Depends(require_active)):
        return quoted_cart(db.requests(user["id"]), settings.pricing)

    @app.post("/api/requests")
    def add_request(body: OrderRequest, user=Depends(require_active)):
        data = body.model_dump()
        rid = db.add_request(user["id"], data)
        return {"id": rid, **quote(data, settings.pricing)}

    @app.put("/api/requests/{request_id}")
    def edit_request(request_id: int, body: OrderRequest, user=Depends(require_active)):
        data = body.model_dump()
        if not db.update_request(user["id"], request_id, data):
            raise HTTPException(404, "no_such_request")
        return {"id": request_id, **quote(data, settings.pricing)}

    @app.delete("/api/requests/{request_id}")
    def remove_request(request_id: int, user=Depends(require_active)):
        if not db.delete_request(user["id"], request_id):
            raise HTTPException(404, "no_such_request")
        return {"ok": True}

    @app.get("/order/export", include_in_schema=False)
    def export_order(user=Depends(require_active)):
        cart = quoted_cart(db.requests(user["id"]), settings.pricing)
        if not cart["items"]:
            raise HTTPException(404, "empty_cart")
        content, filename, media_type = build_order(user, cart, settings.toman_per_usd)
        return Response(
            content,
            media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

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

    def my_products(user: dict[str, Any]) -> list[dict[str, Any]]:
        """Today's hunt and the seller's own analyses: what they may look into."""
        found = []
        latest = db.latest_hunt()
        if latest:
            found += latest[1]["candidates"]
        found += [a["result"] for a in db.analyses(user["id"], 200) if a["result"]]
        return found

    def known_offer_urls(user: dict[str, Any]) -> set[str]:
        """Offers the site itself found for this seller: only these are fetched, so
        nobody can make us pay for looking up arbitrary pages."""
        return {
            o["url"] for c in my_products(user) for o in [c["offer"], *c.get("alternatives", [])]
        }

    @app.get("/api/offer")
    def offer(url: str, user=Depends(require_active)):
        if url not in known_offer_urls(user):
            raise HTTPException(404, "offer_not_found")
        return read_offer(url)

    def read_offer(url: str) -> dict[str, Any]:
        """A 1688 offer's page: from the week's cache, or read now."""
        supplier = settings.link_hunter.supplier if settings.link_hunter else None
        if supplier is None or not hasattr(supplier, "offer_detail"):
            raise HTTPException(503, "details_not_configured")
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

    # --- a product's pictures and videos, for the seller's own listing -----------------

    @app.get("/api/media")
    def media(id: str, user=Depends(require_active)):
        """Every picture and video of one of the seller's products: the 1688 page's (the
        supplier's own), the offer's and the Temu/Amazon listing's."""
        product = next((c for c in my_products(user) if c.get("id") == id), None)
        if product is None:
            raise HTTPException(404, "product_not_found")
        detail = None
        url = (product.get("offer") or {}).get("url")
        if url:
            try:
                detail = read_offer(url)
            except HTTPException:
                detail = None  # the listing's pictures still work
        title = product.get("title_fa") or (product.get("listing") or {}).get("title") or ""
        return {
            "id": id,
            "title": title,
            "page_read": detail is not None,
            **collect(product, detail),
        }

    @app.get("/media/file", include_in_schema=False)
    def media_file(
        u: str, name: str = "", n: int = 1, ready: bool = False, inline: bool = False,
        user=Depends(require_active),
    ):  # fmt: skip
        """One picture or video, through our server, as a download (or shown in the page).
        ready=1: the picture on a white 1200×1200 square, as stores ask for."""
        if not allowed(u, VIDEO_HOSTS):
            raise HTTPException(400, "not_a_media_host")
        try:
            r = image_client.send(image_client.build_request("GET", u), stream=True)
        except httpx.HTTPError:
            raise HTTPException(502, "media_error") from None
        kind = r.headers.get("content-type", "").split(";")[0].strip().lower()
        ext = extension(kind, u)
        is_video = kind.startswith("video/") or (
            kind in ("application/octet-stream", "binary/octet-stream")
            and ext in ("mp4", "mov", "webm")
        )
        if r.status_code != 200 or not (
            kind.startswith("image/") and allowed(u, IMAGE_HOSTS) or is_video
        ):
            r.close()
            raise HTTPException(502, "media_error")
        where = "inline" if inline else disposition(file_name(name, n, "jpg" if ready else ext))
        if not is_video:
            try:
                data = r.read()
            finally:
                r.close()
            if len(data) > MAX_IMAGE:
                raise HTTPException(502, "media_error")
            if ready:
                try:
                    data, kind = store_ready(data), "image/jpeg"
                except Exception:
                    raise HTTPException(502, "media_error") from None
            return Response(data, media_type=kind, headers={
                "Content-Disposition": where, "Cache-Control": "private, max-age=86400"})  # fmt: skip
        length = int(r.headers.get("content-length") or 0)
        if length > MAX_VIDEO:
            r.close()
            raise HTTPException(413, "video_too_big")

        def chunks():
            sent = 0
            try:
                for chunk in r.iter_bytes(65536):
                    sent += len(chunk)
                    if sent > MAX_VIDEO:
                        break
                    yield chunk
            finally:
                r.close()

        headers = {"Content-Disposition": where, "Cache-Control": "private, max-age=86400"}
        if length:
            headers["Content-Length"] = str(length)
        return StreamingResponse(
            chunks(), media_type=kind if kind.startswith("video/") else "video/mp4", headers=headers
        )

    @app.get("/media/zip", include_in_schema=False)
    def media_zip(id: str, user=Depends(require_active)):
        """All of a product's pictures in one ZIP, each as it came and store-ready."""
        found = media(id, user)
        pictures = []
        for item in found["images"]:
            try:
                r = image_client.get(item["url"])
            except httpx.HTTPError:
                continue
            kind = r.headers.get("content-type", "")
            if r.status_code == 200 and kind.startswith("image/") and len(r.content) <= MAX_IMAGE:
                pictures.append((r.content, extension(kind, item["url"])))
        if not pictures:
            raise HTTPException(502, "no_pictures")
        return Response(
            zip_images(found["title"], pictures),
            media_type="application/zip",
            headers={"Content-Disposition": disposition(f"{found['title'] or 'product'}.zip")},
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
    d["returns_by_market"] = RETURN_RESERVE
    d["last_mile_usd"] = [
        [None if kg == float("inf") else kg, cost] for kg, cost in cfg.last_mile_usd
    ]
    return d
