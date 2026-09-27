"""Scoring a find out of 100 and deciding green / yellow / red, with the reasons in Persian."""

from __future__ import annotations

from dataclasses import dataclass, field

from .categories import CATEGORIES, ip_matches, restricted_matches
from .models import MarketListing, Pricing, SupplierOffer


@dataclass
class Assessment:
    score: int
    verdict: str
    pros: list[str] = field(default_factory=list)
    cons: list[str] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)


def _n(x: float) -> str:
    return f"{x:,.0f}"


def monthly_demand(listing: MarketListing) -> int | None:
    """Units a month. Temu only shows lifetime sales; count those as a year's worth."""
    if listing.monthly_sold is not None:
        return listing.monthly_sold
    if listing.sold_total is not None:
        return listing.sold_total // 12
    return None


def assess(
    listing: MarketListing,
    offer: SupplierOffer,
    pricing: Pricing,
    weight_kg: float,
    max_premium: float = 0.10,
) -> Assessment:
    pros: list[str] = []
    cons: list[str] = []
    flags: list[str] = []
    score = 0

    demand = monthly_demand(listing)
    if demand is None:
        score += 10
        cons.append("آمار فروش ماهانه در دسترس نیست")
    elif demand >= 3000:
        score += 25
        pros.append(f"تقاضای خیلی بالا: حدود {_n(demand)} فروش در ماه")
    elif demand >= 1000:
        score += 20
        pros.append(f"تقاضای خوب: حدود {_n(demand)} فروش در ماه")
    elif demand >= 300:
        score += 14
        pros.append(f"تقاضای متوسط: حدود {_n(demand)} فروش در ماه")
    else:
        score += 4
        cons.append(f"تقاضای کم: حدود {_n(demand)} فروش در ماه")

    m = pricing.margin
    if m >= 0.30:
        score += 25
        pros.append(f"حاشیه‌ی سود عالی: {m:.0%}")
    elif m >= 0.22:
        score += 20
        pros.append(f"حاشیه‌ی سود خوب: {m:.0%}")
    elif m >= 0.15:
        score += 14
        pros.append(f"حاشیه‌ی سود قابل‌قبول: {m:.0%}")
    elif m >= 0.08:
        score += 6
        cons.append(f"حاشیه‌ی سود کم: {m:.0%}")
    else:
        cons.append(f"سود نمی‌مونه: حاشیه {m:.0%}")

    ratio = pricing.vs_benchmark
    ref = "Temu (تخمینی از قیمت آمازون)" if pricing.benchmark_estimated else "Temu"
    if ratio is None:
        score += 8
        cons.append("قیمت Temu برای مقایسه پیدا نشد")
    elif ratio <= 0.97:
        score += 20
        pros.append(f"ارزان‌تر از {ref}: {1 - ratio:.0%} پایین‌تر")
    elif ratio <= 1.03:
        score += 15
        pros.append(f"هم‌قیمت {ref}")
    elif ratio <= 1 + max_premium:
        score += 8
        cons.append(f"{ratio - 1:.0%} گران‌تر از {ref}؛ فقط با ارسال سریع یا ضمانت می‌فروشه")
    else:
        cons.append(f"کمترین قیمتی که سود می‌ده {ratio - 1:.0%} بالاتر از {ref}ه؛ رقابتی نیست")

    if listing.reviews is None:
        score += 5
    elif listing.reviews < 500:
        score += 10
        pros.append(f"رقابت کم: رقیب اصلی {_n(listing.reviews)} نظر داره")
    elif listing.reviews < 3000:
        score += 6
    else:
        score += 2
        cons.append(f"بازار شلوغ: رقیب اصلی {_n(listing.reviews)} نظر داره")

    if weight_kg <= 0.5:
        score += 10
        pros.append("سبک و ارزان برای حمل")
    elif weight_kg <= 2:
        score += 6
    else:
        score += 2
        cons.append(f"سنگین ({weight_kg:.1f} کیلو): حمل گرونه")

    if offer.sales is None:
        score += 4
    elif offer.sales >= 1000:
        score += 10
        pros.append(f"تأمین‌کننده‌ی پرفروش در 1688 ({_n(offer.sales)} فروش)")
    elif offer.sales >= 200:
        score += 7
    elif offer.sales >= 50:
        score += 4
    else:
        score += 1
        cons.append("تأمین‌کننده سابقه‌ی فروش کمی داره؛ اول نمونه بخر")

    restricted = restricted_matches(f"{listing.title} {offer.title}")
    if listing.category in CATEGORIES and CATEGORIES[listing.category].restricted:
        restricted.insert(0, CATEGORIES[listing.category])
    for cat in dict.fromkeys(restricted):
        flags.append(f"محدودیت «{cat.fa}»: {cat.note_fa}")

    brands = ip_matches(listing.title)
    if brands:
        flags.append(
            "ریسک برند/پتنت ("
            + "، ".join(brands)
            + "): اسم یا طرح برند نباید روی محصول و آگهی باشه"
        )

    too_dear = ratio is not None and ratio > 1 + max_premium
    if restricted or too_dear or m < 0.08:
        verdict = "red"
    elif score >= 70 and m >= 0.15 and (ratio is None or ratio <= 1.03):
        verdict = "yellow" if brands else "green"
    elif score >= 50:
        verdict = "yellow"
    else:
        verdict = "red"

    return Assessment(min(score, 100), verdict, pros, cons, flags)
