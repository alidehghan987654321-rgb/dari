"""Command line: run a hunt, run the website, manage sellers.

python -m hunter hunt --sample          # try it without API keys
python -m hunter hunt                   # live: needs KEEPA_API_KEY and/or APIFY_TOKEN
python -m hunter serve                  # the website, on port 8100
python -m hunter grant EMAIL --days 30  # activate a seller who paid by bank transfer
python -m hunter make-admin EMAIL
python -m hunter preview OUT.html       # a self-contained page with the sample hunt
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from .categories import find_category, hunt_categories
from .db import Database
from .engine import Hunter
from .pricing import PricingConfig
from .sources.sample import SampleData

log = logging.getLogger("hunter")


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
            DEFAULT_1688_IMAGE_INPUT,
            DEFAULT_1688_KEYWORD_INPUT,
            DEFAULT_TEMU_INPUT,
            Apify,
            Supplier1688,
            TemuMarket,
        )

        apify = Apify(env("APIFY_TOKEN"))
        if env("HUNTER_TEMU_ACTOR"):
            markets.insert(
                0,
                TemuMarket(
                    apify, env("HUNTER_TEMU_ACTOR"), env("HUNTER_TEMU_INPUT") or DEFAULT_TEMU_INPUT
                ),
            )
        if env("HUNTER_1688_IMAGE_ACTOR"):
            supplier = Supplier1688(
                apify,
                env("HUNTER_1688_IMAGE_ACTOR"),
                env("HUNTER_1688_KEYWORD_ACTOR", ""),
                env("HUNTER_1688_IMAGE_INPUT") or DEFAULT_1688_IMAGE_INPUT,
                env("HUNTER_1688_KEYWORD_INPUT") or DEFAULT_1688_KEYWORD_INPUT,
            )
    return markets, supplier


def cmd_hunt(args) -> int:
    cats = (
        [find_category(k) for k in args.categories.split(",")]
        if args.categories
        else hunt_categories()
    )
    cfg = PricingConfig.from_env()
    if args.market:
        cfg = cfg.for_market(args.market)
    if args.sample:
        sample = SampleData()
        hunter, note = Hunter([sample], sample, cfg), sample.note
    else:
        markets, supplier = live_sources()
        if not markets or supplier is None:
            print(
                "No live sources configured. Set KEEPA_API_KEY and/or APIFY_TOKEN +"
                " HUNTER_TEMU_ACTOR for listings, and APIFY_TOKEN + HUNTER_1688_IMAGE_ACTOR"
                " for 1688 (see hunter/README.md), or use --sample.",
                file=sys.stderr,
            )
            return 2
        hunter, note = Hunter(markets, supplier, cfg), ""
    result = hunter.hunt(cats, args.per_category)
    result.sample, result.note = args.sample, note
    data = result.to_dict()
    hunt_id = Database(args.db).save_hunt(data)
    if args.json:
        Path(args.json).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    counts = {v: sum(c.verdict == v for c in result.candidates) for v in ("green", "yellow", "red")}
    print(
        f"Hunt #{hunt_id}: {len(result.candidates)} products "
        f"(green {counts['green']}, yellow {counts['yellow']}, red {counts['red']})"
        + (f", skipped {result.skipped}" if result.skipped else "")
    )
    for c in result.candidates[:10]:
        p = c.pricing
        print(
            f"  {c.verdict:6} {c.score:3}  ${p.price_usd:>7.2f} (Temu ${p.benchmark_usd or 0:.2f})"
            f"  margin {p.margin:.0%}  {c.listing.title[:60]}"
        )
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    from .app import Settings, create_app

    settings = Settings.from_env()
    if args.db:
        settings.db_path = args.db
    uvicorn.run(create_app(settings), host=args.host, port=args.port, proxy_headers=True)
    return 0


def cmd_grant(args) -> int:
    until = Database(args.db).grant(args.email.lower(), args.days)
    if not until:
        print(f"No seller with email {args.email}", file=sys.stderr)
        return 1
    print(f"{args.email}: subscription until {until}")
    return 0


def cmd_make_admin(args) -> int:
    if not Database(args.db).make_admin(args.email.lower()):
        print(f"No seller with email {args.email}", file=sys.stderr)
        return 1
    print(f"{args.email} is now an admin")
    return 0


def cmd_preview(args) -> int:
    from .preview import build_preview

    sample = SampleData()
    cfg = PricingConfig.from_env()
    result = Hunter([sample], sample, cfg).hunt()
    result.sample, result.note = True, sample.note
    Path(args.out).write_text(build_preview(result.to_dict(), cfg), encoding="utf-8")
    print(f"Wrote {args.out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"), format="%(levelname)s %(name)s: %(message)s"
    )
    db_default = os.environ.get("HUNTER_DB", "hunter-data/hunter.db")

    parser = argparse.ArgumentParser(
        prog="python -m hunter", description="Product hunter for the store's sellers"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("hunt", help="find products and save the hunt")
    p.add_argument("--sample", action="store_true", help="use the bundled sample data")
    p.add_argument("--categories", help="comma separated category keys (default: all allowed)")
    p.add_argument("--per-category", type=int, default=20)
    p.add_argument("--market", choices=["prepaid", "cod"], help="default: HUNTER_MARKET or prepaid")
    p.add_argument("--db", default=db_default)
    p.add_argument("--json", help="also write the hunt to this JSON file")
    p.set_defaults(func=cmd_hunt)

    p = sub.add_parser("serve", help="run the website")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8100)
    p.add_argument("--db")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("grant", help="activate or extend a seller's subscription")
    p.add_argument("email")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--db", default=db_default)
    p.set_defaults(func=cmd_grant)

    p = sub.add_parser("make-admin", help="let a seller see everything without paying")
    p.add_argument("email")
    p.add_argument("--db", default=db_default)
    p.set_defaults(func=cmd_make_admin)

    p = sub.add_parser("preview", help="write a self-contained demo page of the sample hunt")
    p.add_argument("out")
    p.set_defaults(func=cmd_preview)

    args = parser.parse_args(argv)
    return args.func(args)
