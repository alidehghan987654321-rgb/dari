"""One key per product link, so the same product pasted twice is only analysed once.

Amazon links are known by their ASIN and Temu links by their goods ID, whatever
tracking bits follow them.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit

ASIN = re.compile(r"/(?:dp|gp/product|gp/aw/d|product)/([A-Z0-9]{10})(?:[/?#]|$)")
TEMU_GOODS = re.compile(r"-g-(\d{6,})\.html")


def link_key(url: str) -> str:
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower().removeprefix("www.")
    if host.startswith("amazon.") and (m := ASIN.search(parts.path + "/")):
        return f"amazon:{host}:{m.group(1)}"
    if host == "temu.com" or host.endswith(".temu.com"):
        if m := TEMU_GOODS.search(parts.path):
            return f"temu:{m.group(1)}"
        if goods := parse_qs(parts.query).get("goods_id"):
            return f"temu:{goods[0]}"
    return f"{host}{parts.path}?{parts.query}" if parts.query else f"{host}{parts.path}"
