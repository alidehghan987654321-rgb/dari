"""The sellers' website: sign up, pay for a subscription, then see the hunts,
get products of your own and analyse any product.

    python -m hunter serve
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth
from .allocate import choose_picks
from .categories import CATEGORIES, classify, pack_qty
from .db import Database, is_active
from .models import MarketListing, SupplierOffer
from .payments import DemoGateway, Gateway, PaymentError, Plan, Zarinpal, default_plans
from .pricing import PricingConfig, Unprofitable, price_product
from .scoring import assess

log = logging.getLogger(__name__)

STATIC = Path(__file__).resolve().parent / "static"
FONTS = Path(__file__).resolve().parent.parent / "static" / "fonts"
COOKIE = "hunter_session"
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass
class Settings:
    db_path: str = "hunter-data/hunter.db"
    public_url: str = "http://localhost:8100"  # where the site is reached; for the payment callback
    brand: str = "شکارچی"
    gateway: Gateway | None = None  # None: no online payment, an admin activates sellers
    plans: list[Plan] = field(default_factory=lambda: default_plans(1_000_000, 2_500_000))
    pricing: PricingConfig = field(default_factory=PricingConfig)
    per_product: int = 3  # sellers per product
    picks_per_seller: int = 8
    teaser_size: int = 3

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
        return cls(
            db_path=env("HUNTER_DB", cls.db_path),
            public_url=env("HUNTER_PUBLIC_URL", cls.public_url).rstrip("/"),
            brand=env("HUNTER_BRAND", cls.brand),
            gateway=gateway,
            plans=default_plans(
                int(env("HUNTER_PRICE_MONTHLY_TOMAN", "1000000")),
                int(env("HUNTER_PRICE_QUARTERLY_TOMAN", "2500000")),
            ),
            pricing=PricingConfig.from_env(),
            per_product=int(env("HUNTER_SELLERS_PER_PRODUCT", "3")),
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


class Analyze(BaseModel):
    title: str = Field(default="", max_length=300)
    price_cny: float = Field(gt=0, le=100_000)
    weight_kg: float = Field(gt=0, le=100)
    temu_price_usd: float | None = Field(default=None, ge=0, le=100_000)
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
    throttle = auth.Throttle()
    app = FastAPI(title=settings.brand, docs_url=None, redoc_url=None)
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

    # --- pages -----------------------------------------------------------------

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(STATIC / "index.html")

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
        return public_user(db.user(user_id))

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
        return public_user(user)

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
        try:
            pricing = price_product(
                body.price_cny, weight, body.temu_price_usd or None, cfg, units=units
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

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    if FONTS.is_dir():
        app.mount("/fonts", StaticFiles(directory=FONTS), name="fonts")
    return app


def pricing_settings(cfg: PricingConfig) -> dict[str, Any]:
    """The pricing assumptions, for the page to show (JSON has no infinity)."""
    d = asdict(cfg)
    d["last_mile_usd"] = [
        [None if kg == float("inf") else kg, cost] for kg, cost in cfg.last_mile_usd
    ]
    return d
