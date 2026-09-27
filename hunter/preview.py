"""A self-contained demo page of the site: the sample hunt baked in, no server needed.

It is the real page (static/index.html, app.css, app.js) with the data inlined and
window.HUNTER_DEMO set, so app.js skips the server. Fonts come from Google Fonts here
because the self-hosted ones aren't next to the file.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .allocate import choose_picks
from .app import example_links, pricing_settings, public_user
from .categories import CATEGORIES
from .engine import Hunter
from .offers import offer_view
from .payments import make_plans
from .pricing import PricingConfig
from .sources.sample import SampleData

STATIC = Path(__file__).resolve().parent / "static"
FONTS_LINK = (
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
    'family=Vazirmatn:wght@400;700;900&display=swap">'
)


def _between(text: str, start: str, end: str) -> str:
    return text.split(start, 1)[1].split(end, 1)[0]


class _NoStore:
    """No database behind the preview: nothing remembered, nothing translated."""

    def names(self, keys):
        return {}

    def save_names(self, names):
        pass


def build_preview(hunt: dict, pricing: PricingConfig | None = None) -> str:
    pricing = pricing or PricingConfig()
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    css = (STATIC / "app.css").read_text(encoding="utf-8")
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    css = re.sub(r"/\*fonts:start\*/.*?/\*fonts:end\*/", "", css, flags=re.S)
    markup = _between(html, "<!--app:start-->", "<!--app:end-->")

    sample = SampleData()
    candidates = hunt["candidates"]
    # What "new today" looks like (a real site compares with yesterday's hunt).
    for c in [c for c in candidates if c["verdict"] == "green"][:3]:
        c["is_new"] = True
    offers = {o["url"] for c in candidates for o in [c["offer"], *c.get("alternatives", [])]}
    details = {
        url: offer_view(detail, None, _NoStore())
        for url in offers
        if (detail := sample.offer_detail(url))
    }
    counts: dict[str, int] = {}
    for c in candidates:
        counts[c["verdict"]] = counts.get(c["verdict"], 0) + 1
    by_id = {c["id"]: c for c in candidates}
    budget = 1500.0
    picked = [by_id[i] for i in choose_picks(candidates, [], budget, {})]
    me = public_user(
        {
            "id": 0,
            "email": "demo@example.com",
            "name": "فروشنده‌ی نمونه",
            "phone": "",
            "categories": [],
            "budget_usd": budget,
            "paid_until": "2099-01-01T00:00:00+00:00",
            "is_admin": 0,
            "plan": "pro",
        }
    )
    demo = {
        "config": {
            "brand": "شکارچی",
            "online_payment": True,
            "plans": [p.__dict__ for p in make_plans(234_500)],
            "categories": [
                {"key": c.key, "fa": c.fa, "restricted": c.restricted, "note_fa": c.note_fa}
                for c in CATEGORIES.values()
            ],
            "hunt": {"started_at": hunt["started_at"], "sample": True},
            "pricing": pricing_settings(pricing),
            "links": True,
            "links_per_request": 10,
            "monthly_links": 30,
            "example_links": example_links(Hunter([sample], sample)),
        },
        "me": me,
        "hunt": {
            "id": 1,
            "started_at": hunt["started_at"],
            "sample": True,
            "note": hunt.get("note", ""),
            "counts": counts,
            "locked": False,
            "candidates": candidates,
        },
        "details": details,
        "picks": {
            "hunt_id": 1,
            "budget_usd": budget,
            "per_product": 3,
            "capital_usd": round(sum(c["starter_capital_usd"] for c in picked), 2),
            "candidates": picked,
        },
    }
    data = json.dumps(demo, ensure_ascii=False).replace("</", "<\\/")
    return (
        "<title>شکارچی محصول</title>\n"
        f"{FONTS_LINK}\n<style>\n{css}\n</style>\n{markup}\n"
        f"<script>window.HUNTER_DEMO = {data};</script>\n<script>\n{js}\n</script>\n"
    )
