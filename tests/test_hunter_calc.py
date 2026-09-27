"""The site's calculator (hunter/static/calc.js) must price exactly like hunter/pricing.py."""

import json
import math
import shutil
import subprocess
from dataclasses import asdict
from pathlib import Path

import pytest

from hunter.app import pricing_settings
from hunter.pricing import PricingConfig, price_product

CALC = Path(__file__).resolve().parent.parent / "hunter" / "static" / "calc.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(not NODE, reason="node isn't installed")

CASES = [
    # (1688 price ¥, weight kg, Temu $, Amazon $, units, market, items per cart)
    (10.0, 0.3, 14.0, None, 1, "prepaid", 3),
    (6.65, 0.4, 11.99, 16.99, 2, "prepaid", 3),
    (40.0, 1.0, 5.0, None, 1, "prepaid", 3),
    (21.0, 0.8, 19.99, 29.99, 1, "cod", 1),
    (32.0, 2.5, None, 29.99, 1, "prepaid", 5),
    (3.2, 0.12, None, None, 3, "cod", 3),
]


def run_js(inputs, cfg):
    script = (
        f"const c = require({json.dumps(str(CALC))});"
        f"const cfg = {json.dumps(cfg)};"
        f"console.log(JSON.stringify({json.dumps(inputs)}.map(i => c.compute(i, cfg))));"
    )
    out = subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_calculator_prices_like_the_engine():
    base = PricingConfig()
    inputs = [
        {"price": cny, "weight_kg": kg, "temu_usd": temu, "amazon_usd": amazon, "units": units,
         "market": market, "items_per_cart": cart}
        for cny, kg, temu, amazon, units, market, cart in CASES
    ]  # fmt: skip
    results = run_js(inputs, pricing_settings(base))
    for (cny, kg, temu, amazon, units, market, cart), js in zip(CASES, results, strict=True):
        cfg = base.for_market(market)
        cfg = PricingConfig(**{**asdict(cfg), "items_per_cart": cart})
        benchmark = temu or (amazon * cfg.temu_vs_amazon if amazon else None)
        py = price_product(
            cny, kg, benchmark, cfg, units=units, amazon_usd=amazon,
            benchmark_estimated=not temu and bool(amazon),
        )  # fmt: skip
        for field in ("factory_usd", "freight_usd", "landed_usd", "last_mile_usd", "price_usd",
                      "floor_usd", "breakeven_usd", "profit_usd", "margin", "roi", "multiplier",
                      "vs_benchmark", "vs_amazon", "platform_fee_usd", "returns_reserve_usd"):  # fmt: skip
            assert js[field] == pytest.approx(getattr(py, field), abs=0.011), (cny, field)


def test_calculator_extras():
    cfg = pricing_settings(PricingConfig())
    script = (
        f"const c = require({json.dumps(str(CALC))});"
        f"const cfg = {json.dumps(cfg)};"
        "const r = c.compute({price: 21, weight_kg: 0.3, dims: {l: 40, w: 30, h: 10}, temu_usd: 19.99,"
        " freight: 'sea', items_per_cart: 3}, cfg);"
        "const own = c.at(r, 24.99);"
        "const s = c.shipment(r, 100, 50, 234500);"
        "const parts = c.split(r).reduce((a, p) => a + p.value, 0);"
        "const usd = c.compute({price: 2.96, currency: 'usd', weight_kg: 0.3}, cfg);"
        "const cny = c.compute({price: 2.96 * cfg.cny_per_usd, weight_kg: 0.3}, cfg);"
        "console.log(JSON.stringify({r, own, s, parts, usd: usd.price_usd, cny: cny.price_usd}));"
    )
    out = json.loads(
        subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True).stdout
    )
    r = out["r"]
    assert r["weight"]["volumetric"] == 2.0 and r["weight"]["chargeable"] == 2.0  # 40×30×10 / 6000
    assert r["freight_usd"] == pytest.approx(
        2.0 * 1.2, abs=0.01
    )  # sea rate on the volumetric weight
    assert out["own"]["price_usd"] == 24.99 and out["own"]["profit_usd"] > r["profit_usd"]
    s = out["s"]
    assert s["capital_usd"] == pytest.approx(100 * r["landed_usd"], abs=0.01)
    assert s["capital_toman"] == round(s["capital_usd"] * 234500)
    per_sale = r["landed_usd"] + r["profit_usd"]  # what each sale brings back
    assert s["units_to_cash_back"] == math.ceil(s["capital_usd"] / per_sale)
    assert s["units_to_cash_back"] < 100  # the money is back before the last piece sells
    assert s["cash_back_months"] == pytest.approx(s["units_to_cash_back"] / 50, abs=0.05)
    assert s["sell_out_months"] == 2.0 and s["monthly_profit_usd"] == pytest.approx(
        50 * r["profit_usd"]
    )
    assert out["parts"] == pytest.approx(
        r["price_usd"], abs=0.03
    )  # the five parts make up the price
    assert out["usd"] == out["cny"]
