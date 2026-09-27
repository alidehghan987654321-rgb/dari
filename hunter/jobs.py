"""The daily hunt, shared by the command line and the site's scheduled trigger."""

from __future__ import annotations

import logging
import threading

from .categories import Category, hunt_categories
from .db import Database
from .engine import HuntResult, Hunter
from .pricing import PricingConfig
from .sources.sample import SampleData
from .translate import PersianNamer, name_candidates
from .wiring import live_sources

log = logging.getLogger(__name__)

NO_SOURCES = (
    "No live sources configured. Set KEEPA_API_KEY and/or APIFY_TOKEN + HUNTER_TEMU_ACTOR for"
    " listings, and APIFY_TOKEN + HUNTER_1688_IMAGE_ACTOR for 1688 (see hunter/README.md)."
)
_running = threading.Lock()  # one hunt at a time in a process


class NoSources(Exception):
    pass


def run_hunt(
    db: Database,
    cfg: PricingConfig,
    *,
    sample: bool = False,
    categories: list[Category] | None = None,
    per_category: int = 20,
) -> tuple[int, dict, HuntResult]:
    """Hunt (live, or the bundled sample data), name the finds in Persian and save them."""
    if sample:
        data_source = SampleData()
        hunter, note = Hunter([data_source], data_source, cfg), data_source.note
    else:
        markets, supplier = live_sources()
        if not markets or supplier is None:
            raise NoSources(NO_SOURCES)
        hunter, note = Hunter(markets, supplier, cfg), ""
    result = hunter.hunt(categories or hunt_categories(), per_category)
    result.sample, result.note = sample, note
    data = result.to_dict()
    name_candidates(data["candidates"], PersianNamer.from_env(), db)
    return db.save_hunt(data), data, result


def daily_hunt(db: Database, cfg: PricingConfig) -> str:
    """What the scheduled trigger runs: a live hunt, or the sample one while the site has
    no data keys and nothing to show. Never raises; says what it did."""
    if not _running.acquire(blocking=False):
        return "already_running"
    try:
        try:
            hunt_id, _, result = run_hunt(db, cfg)
            return f"hunt {hunt_id}: {len(result.candidates)} products"
        except NoSources:
            if db.latest_hunt_time():
                return "no_sources"
            hunt_id, _, _ = run_hunt(db, cfg, sample=True)
            return f"sample hunt {hunt_id}"
    except Exception:
        log.exception("daily hunt failed")
        return "failed"
    finally:
        _running.release()
