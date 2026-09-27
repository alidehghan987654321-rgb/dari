"""A 1688 offer as our site shows it: in Persian, with the supplier's level.

Sellers in Iran can't sign up on 1688 and often can't open it, so the offer page is
brought over: pictures (through our image proxy), specs, variants and prices, the shop's
record and badges. Attribute names and badges come from a fixed glossary; other Chinese
text goes to Claude when it's configured, and each text is translated once.
"""

from __future__ import annotations

import re

from .glossary import attribute_fa, badge_fa, value_fa
from .models import OfferDetail
from .scoring import supplier_level
from .translate import PersianNamer

CJK = re.compile(r"[一-鿿]")


def offer_view(detail: OfferDetail, namer: PersianNamer | None, db) -> dict:
    view = detail.to_dict()
    view["level"] = supplier_level(detail.offer)
    view["badges_fa"] = [badge_fa(b) or b for b in detail.badges]

    # Chinese texts without a glossary entry: the title, attribute values, variant names.
    texts = {"title": detail.offer.title}
    for i, (_, value) in enumerate(detail.attributes):
        if not value_fa(value):
            texts[f"attr:{i}"] = value
    for i, sku in enumerate(detail.skus):
        texts[f"sku:{i}"] = sku["name"]
    texts = {k: v for k, v in texts.items() if v and CJK.search(v)}
    fa = translate(texts, namer, db)

    view["title_fa"] = detail.title_fa or fa.get("title", "")
    view["attributes_fa"] = [
        [attribute_fa(name) or name, value_fa(value) or fa.get(f"attr:{i}", value)]
        for i, (name, value) in enumerate(detail.attributes)
    ]
    view["skus_fa"] = [
        {**sku, "name_fa": fa.get(f"sku:{i}", "")} for i, sku in enumerate(detail.skus)
    ]
    return view


def translate(texts: dict[str, str], namer: PersianNamer | None, db) -> dict[str, str]:
    """{key: Chinese text} -> {key: Persian}, remembering every text translated."""
    if not texts:
        return {}
    stored = db.names([f"zh:{t}" for t in texts.values()])
    missing = {t: t for t in texts.values() if f"zh:{t}" not in stored}
    if missing and namer:
        fresh = namer.translate_texts(missing)
        if fresh:
            db.save_names({f"zh:{t}": fa for t, fa in fresh.items()})
            stored.update({f"zh:{t}": fa for t, fa in fresh.items()})
    return {k: stored[f"zh:{t}"] for k, t in texts.items() if f"zh:{t}" in stored}
