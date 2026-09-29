"""What the plans cost us, and what they sell for.

Costs come in three kinds:
- fixed, each month, however many subscribe: the data services, hosting, Persian names and the
  rest;
- per analysis: each product link a subscriber analyses costs a few cents when it isn't in the
  cache: the data for it, the 1688 page it opens, and Claude for its Persian name and that
  page's texts (by the model in use). A plan is costed at its full quota with no cache hits, the
  worst case;
- on each sale, a share of the price: the payment gateway, tax, and marketing and support.

A plan's price covers its analyses, its share of the fixed costs (spread over the subscribers we
plan for) and the sales costs, and leaves the target net margin:

    price = (analyses + share of fixed) / (1 - sales share - margin)

rounded up to a dollar price ending in .99, so the margin ends a little above the target; the
toman price follows from the day's rate. A plan that falls under the floor (a plan priced by
hand, a new cost) is flagged. Every figure can be changed from the environment (see from_env).
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field, replace
from typing import Any

from .translate import DEFAULT_MODEL


@dataclass(frozen=True)
class Cost:
    key: str
    fa: str
    value: float  # dollars a month (fixed), dollars each (per analysis), or a share of the price (sales)
    note_fa: str = ""


# Claude's list prices per million tokens (input, output).
CLAUDE_PRICES = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-opus-5": (5.0, 25.0),
}


def ai_usd(model: str) -> float:
    """What Claude costs for one analysis at most: its Persian name (a 25th of a request) and
    its 1688 page's texts (one request, up to 25 of them). Models that think write more. An
    unknown model is costed like Opus 5."""
    price_in, price_out = CLAUDE_PRICES.get(model, CLAUDE_PRICES["claude-opus-5"])
    tokens_in, tokens_out = 615, 540 + (0 if model.startswith("claude-haiku") else 310)
    return round((tokens_in * price_in + tokens_out * price_out) / 1e6, 4)


def fixed_costs(model: str) -> tuple[Cost, ...]:
    return (
        Cost(
            "keepa",
            "داده‌ی آمازون (Keepa)",
            53,
            "پلن پایه‌ی Keepa، 49 یورو در ماه؛ برای بدترین حالت هم کافیه",
        ),
        Cost(
            "apify",
            "داده‌ی Temu و 1688 (Apify)",
            35,
            "اشتراک و شکار روزانه؛ محصولی که تا 7 روز پیش جستجو شده دوباره جستجو نمیشه",
        ),
        Cost(
            "hosting",
            "سرور و دیتابیس (Cloudflare)",
            25,
            "Workers Paid، کانتینر سایت و پشتیبان در R2",
        ),
        # the hunt's own names and pages: about 1,500 new products and 1,000 pages a month
        Cost("names", "اسم و ترجمه‌ی شکار روزانه (Claude)", round(1000 * ai_usd(model), 2), model),
        Cost("misc", "دامنه، ایمیل و متفرقه", 5),
    )


def analysis_costs(model: str) -> tuple[Cost, ...]:
    return (
        Cost(
            "lookup",
            "داده‌ی هر تحلیل لینک",
            0.03,
            "Keepa یا Apify و جستجوی تصویری 1688 با 6 نتیجه، وقتی در کش نیست",
        ),
        Cost("page", "صفحه‌ی 1688 داخل سایت", 0.01, "بار اولی که باز میشه؛ بعدش دو هفته در کش"),
        Cost(
            "ai",
            "اسم و ترجمه با Claude",
            ai_usd(model),
            model + "؛ واژه‌های رایج از فرهنگ لغت خود سایت",
        ),
    )


FIXED = fixed_costs(DEFAULT_MODEL)
PER_ANALYSIS = analysis_costs(DEFAULT_MODEL)
SALES = (
    Cost("gateway", "کارمزد درگاه پرداخت", 0.01, "زرین‌پال"),
    Cost("tax", "مالیات بر ارزش افزوده", 0.10, "اگه مشمول نیستی صفرش کن"),
    Cost("growth", "بازاریابی و پشتیبانی", 0.10, "تبلیغات، پورسانت معرف و وقت پشتیبانی"),
)
# How subscribers are expected to split between the plans, for the monthly totals.
MIX = {"basic": 0.5, "pro": 0.35, "business": 0.15}


def charm_usd(usd: float) -> float:
    """The first price ending in .99 at or above this one: 4.95 -> 4.99, 5.10 -> 5.99."""
    price = math.ceil(usd) - 0.01
    return round(price if price >= usd - 1e-9 else price + 1, 2)


@dataclass
class Economics:
    fixed: tuple[Cost, ...] = FIXED
    per_analysis: tuple[Cost, ...] = PER_ANALYSIS
    sales: tuple[Cost, ...] = SALES
    model: str = DEFAULT_MODEL  # Claude's model, for the record
    margin: float = 0.40  # the net margin a plan's price is set for
    min_margin: float = 0.30  # under this, a plan is flagged
    subscribers: int = 200  # paying subscribers the fixed costs are spread over
    mix: dict[str, float] = field(default_factory=lambda: dict(MIX))

    @property
    def fixed_usd(self) -> float:
        return sum(c.value for c in self.fixed)

    @property
    def analysis_usd(self) -> float:
        return sum(c.value for c in self.per_analysis)

    @property
    def sales_share(self) -> float:
        return sum(c.value for c in self.sales)

    @property
    def fixed_share_usd(self) -> float:
        return self.fixed_usd / max(1, self.subscribers)

    def price_usd(self, links: int) -> float:
        """The price a plan with this many analyses a month needs, before rounding."""
        keep = 1 - self.sales_share - self.margin
        if keep <= 0.05:
            raise ValueError("sales costs and the margin leave nothing to cover the costs")
        return (links * self.analysis_usd + self.fixed_share_usd) / keep

    def price(self, links: int) -> float:
        """A plan's price in dollars, as sold: rounded up to .99."""
        return charm_usd(self.price_usd(links))

    def plan(self, links: int, price_usd: float) -> dict[str, float]:
        """What one subscriber of a plan brings in and costs us a month, at worst."""
        analyses = links * self.analysis_usd
        sales = price_usd * self.sales_share
        cost = analyses + self.fixed_share_usd + sales
        profit = price_usd - cost
        return {
            "analyses_usd": round(analyses, 2),
            "fixed_usd": round(self.fixed_share_usd, 2),
            "sales_usd": round(sales, 2),
            "cost_usd": round(cost, 2),
            "profit_usd": round(profit, 2),
            "margin": round(profit / price_usd, 4) if price_usd else 0.0,
        }

    def report(self, plans: list[Any], toman_per_usd: float) -> dict[str, Any]:
        """The costs by kind, each plan's price, costs and margin, the break-even point and the
        month at a few sizes. `plans` are payments.Plan."""
        rows = []
        for p in plans:
            row = {
                "id": p.id,
                "name_fa": p.name_fa,
                "links": p.links,
                "price_toman": p.price_toman,
                "price_usd": p.price_usd,
                **self.plan(p.links, p.price_usd),
            }
            row["ok"] = row["margin"] >= self.min_margin
            rows.append(row)
        weights = {r["id"]: self.mix.get(r["id"], 0.0) for r in rows}
        total = sum(weights.values()) or 1.0
        # What an average subscriber leaves towards the fixed costs, and how many cover them.
        contribution = sum(
            weights[r["id"]] / total * (r["price_usd"] - r["analyses_usd"] - r["sales_usd"])
            for r in rows
        )
        revenue = sum(weights[r["id"]] / total * r["price_usd"] for r in rows)

        def month(n: int) -> dict[str, Any]:
            profit = n * contribution - self.fixed_usd
            return {
                "subscribers": n,
                "revenue_usd": round(n * revenue, 2),
                "cost_usd": round(n * (revenue - contribution) + self.fixed_usd, 2),
                "profit_usd": round(profit, 2),
                "profit_toman": int(round(profit * toman_per_usd, -4)),
            }

        def kind(key: str, fa: str, unit: str, costs: tuple[Cost, ...]) -> dict[str, Any]:
            return {
                "key": key,
                "fa": fa,
                "unit": unit,
                "total": round(sum(c.value for c in costs), 4),
                "items": [
                    {"key": c.key, "fa": c.fa, "value": c.value, "note_fa": c.note_fa}
                    for c in costs
                ],
            }

        return {
            "toman_per_usd": toman_per_usd,
            "model": self.model,
            "margin": self.margin,
            "min_margin": self.min_margin,
            "subscribers": self.subscribers,
            "mix": weights,
            "kinds": [
                kind("fixed", "ثابت ماهانه", "usd_month", self.fixed),
                kind("analysis", "هر تحلیل لینک (بدترین حالت)", "usd_each", self.per_analysis),
                kind("sales", "روی هر فروش", "share", self.sales),
            ],
            "plans": rows,
            "break_even": math.ceil(self.fixed_usd / contribution) if contribution > 0 else None,
            "months": [month(n) for n in (50, 100, self.subscribers, 500, 1000) if n > 0],
        }

    @classmethod
    def from_env(cls) -> Economics:
        """HUNTER_MARGIN, HUNTER_MIN_MARGIN, HUNTER_SUBSCRIBERS, HUNTER_CLAUDE_MODEL (its AI
        costs), and HUNTER_COSTS: a JSON object from a cost's key to its value, e.g.
        {"keepa": 53, "lookup": 0.03, "tax": 0}."""
        env = os.environ.get
        costs = json.loads(env("HUNTER_COSTS") or "{}")
        model = env("HUNTER_CLAUDE_MODEL") or DEFAULT_MODEL

        def set_values(items: tuple[Cost, ...]) -> tuple[Cost, ...]:
            return tuple(
                replace(c, value=float(costs[c.key])) if c.key in costs else c for c in items
            )

        return cls(
            fixed=set_values(fixed_costs(model)),
            per_analysis=set_values(analysis_costs(model)),
            sales=set_values(SALES),
            model=model,
            margin=float(env("HUNTER_MARGIN", "0.40")),
            min_margin=float(env("HUNTER_MIN_MARGIN", "0.30")),
            subscribers=int(env("HUNTER_SUBSCRIBERS", "200")),
        )
