"""The seller's order cart (ثبت درخواست): the products they chose, priced for a RhinoMall
order.

A cart line stores only what the seller put in (see the inputs below); the money is worked
out on every read with the same contract pricing the rest of the site uses, so a change to
the rate or the fees is reflected at once. The sheet that goes to RhinoMall is built from
these lines in hunter.export.
"""

from __future__ import annotations

import math
from typing import Any

from .categories import CATEGORIES
from .pricing import PricingConfig, Unprofitable, price_product

# The inputs a cart line keeps, with their defaults. Anything else sent is ignored.
FIELDS: dict[str, Any] = {
    "title_fa": "محصول",
    "category": "",
    "product_url": "",  # the 1688 (or chosen supplier) link
    "reference_url": "",  # the Amazon/Temu listing it was compared with
    "keyword_en": "",
    "keyword_zh": "",
    "price_cny": 0.0,  # per supplier piece, at the minimum order
    "units": 1,  # supplier pieces in one sold listing
    "moq": 1,
    "weight_kg": 0.0,
    "amazon_usd": None,
    "temu_usd": None,
    "capital_usd": 0.0,  # what the seller wants to put in; sets the quantity
    "qty": None,  # an explicit order quantity overrides the one from the capital
    "note": "",
}


def clean(raw: dict[str, Any]) -> dict[str, Any]:
    """Keep only the known fields, with the right types and sane bounds."""
    out: dict[str, Any] = {}
    for key, default in FIELDS.items():
        value = raw.get(key, default)
        if key in ("units", "moq"):
            value = max(1, int(value or 1))
        elif key == "qty":
            value = None if value in (None, "") else max(0, int(value))
        elif key in ("price_cny", "weight_kg", "capital_usd"):
            value = max(0.0, float(value or 0))
        elif key in ("amazon_usd", "temu_usd"):
            value = None if value in (None, "") else max(0.0, float(value))
        else:
            value = str(value or default or "").strip()
        out[key] = value
    return out


def quote(raw: dict[str, Any], cfg: PricingConfig) -> dict[str, Any]:
    """Price one cart line: cost to Dubai, selling price, the order's quantity and totals."""
    item = clean(raw)
    units, moq = item["units"], item["moq"]
    weight = item["weight_kg"] or 0.01  # a tiny default keeps the math defined
    temu, amazon = item["temu_usd"], item["amazon_usd"]
    benchmark = temu or (amazon * cfg.temu_vs_amazon if amazon else None)
    priced: dict[str, Any] = {**item, "ok": item["price_cny"] > 0}
    if not priced["ok"]:
        return {**priced, "qty": item["qty"] or moq, **_zero()}
    try:
        pricing = price_product(
            item["price_cny"],
            weight,
            benchmark,
            cfg,
            benchmark_estimated=not temu and bool(amazon),
            units=units,
            amazon_usd=amazon,
        )
    except Unprofitable:
        return {**priced, "ok": False, "qty": item["qty"] or moq, **_zero()}

    landed = pricing.landed_usd
    if item["qty"] is not None:
        qty = max(1, item["qty"])
    elif item["capital_usd"] > 0 and landed > 0:
        qty = max(moq, math.floor(item["capital_usd"] / landed))
    else:
        qty = moq
    return {
        **priced,
        "qty": qty,
        "landed_usd": landed,
        "sell_usd": pricing.price_usd,
        "profit_usd": pricing.profit_usd,
        "margin": pricing.margin,
        "roi": pricing.roi,
        "order_capital_usd": round(qty * landed, 2),
        "order_income_usd": round(qty * pricing.price_usd, 2),
        "order_profit_usd": round(qty * pricing.profit_usd, 2),
    }


def _zero() -> dict[str, Any]:
    return {
        "landed_usd": 0.0,
        "sell_usd": 0.0,
        "profit_usd": 0.0,
        "margin": 0.0,
        "roi": 0.0,
        "order_capital_usd": 0.0,
        "order_income_usd": 0.0,
        "order_profit_usd": 0.0,
    }


def summarize(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Totals for the whole cart and a count per category."""
    categories: dict[str, int] = {}
    for it in items:
        key = it.get("category") or "other"
        categories[key] = categories.get(key, 0) + 1
    capital = round(sum(it["order_capital_usd"] for it in items), 2)
    income = round(sum(it["order_income_usd"] for it in items), 2)
    profit = round(sum(it["order_profit_usd"] for it in items), 2)
    return {
        "count": len(items),
        "categories": [
            {"key": k, "fa": CATEGORIES[k].fa if k in CATEGORIES else k, "n": n}
            for k, n in sorted(categories.items(), key=lambda kv: -kv[1])
        ],
        "total_qty": sum(it["qty"] for it in items),
        "capital_usd": capital,
        "income_usd": income,
        "profit_usd": profit,
        "margin": round(profit / income, 4) if income else 0.0,
    }


def quoted_cart(rows: list[dict[str, Any]], cfg: PricingConfig) -> dict[str, Any]:
    """The cart as the site and the export see it: every line priced, plus the summary."""
    items = [{"id": r["id"], **quote(r["data"], cfg)} for r in rows]
    return {"items": items, "summary": summarize(items)}
