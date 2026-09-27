"""Building the hunter's sources from the environment (.env)."""

from __future__ import annotations

import os

from .engine import Hunter
from .pricing import PricingConfig
from .sources.sample import SampleData


def live_sources() -> tuple[list, object | None]:
    """Market sources and the 1688 source configured in the environment."""
    env = os.environ.get
    markets: list = []
    supplier = None
    if env("KEEPA_API_KEY"):
        from .sources.keepa import Keepa

        markets.append(Keepa(env("KEEPA_API_KEY")))
    if env("APIFY_TOKEN"):
        from .sources.apify import (
            DEFAULT_1688_BATCH_INPUT,
            DEFAULT_1688_IMAGE_INPUT,
            DEFAULT_1688_KEYWORD_INPUT,
            DEFAULT_TEMU_INPUT,
            DEFAULT_TEMU_PRODUCT_INPUT,
            Apify,
            Supplier1688,
            TemuMarket,
        )

        apify = Apify(env("APIFY_TOKEN"))
        if env("HUNTER_TEMU_ACTOR"):
            markets.insert(
                0,
                TemuMarket(
                    apify,
                    env("HUNTER_TEMU_ACTOR"),
                    env("HUNTER_TEMU_INPUT") or DEFAULT_TEMU_INPUT,
                    env("HUNTER_TEMU_PRODUCT_ACTOR", ""),
                    env("HUNTER_TEMU_PRODUCT_INPUT") or DEFAULT_TEMU_PRODUCT_INPUT,
                ),
            )
        if env("HUNTER_1688_IMAGE_ACTOR"):
            supplier = Supplier1688(
                apify,
                env("HUNTER_1688_IMAGE_ACTOR"),
                env("HUNTER_1688_KEYWORD_ACTOR", ""),
                env("HUNTER_1688_IMAGE_INPUT") or DEFAULT_1688_IMAGE_INPUT,
                env("HUNTER_1688_KEYWORD_INPUT") or DEFAULT_1688_KEYWORD_INPUT,
                env("HUNTER_1688_BATCH_INPUT", DEFAULT_1688_BATCH_INPUT),
            )
    return markets, supplier


def link_hunter() -> Hunter | None:
    """The hunter that analyses the links sellers paste on the site: the live sources, or
    the sample data with HUNTER_SAMPLE=1 (for trying the site out)."""
    cfg = PricingConfig.from_env()
    if os.environ.get("HUNTER_SAMPLE") == "1":
        sample = SampleData()
        return Hunter([sample], sample, cfg)
    markets, supplier = live_sources()
    if markets and supplier is not None:
        return Hunter(markets, supplier, cfg)
    return None
