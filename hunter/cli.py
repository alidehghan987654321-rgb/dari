"""Command line: run a hunt, run the website, manage sellers.

python -m hunter hunt --sample          # try it without API keys
python -m hunter hunt                   # live: needs KEEPA_API_KEY and/or APIFY_TOKEN
python -m hunter serve                  # the website, on port 8100
python -m hunter grant EMAIL --days 30  # activate a seller who paid by bank transfer
python -m hunter make-admin EMAIL
python -m hunter preview OUT.html       # a self-contained page with the sample hunt
python -m hunter backup                 # copy the database to hunter-data/backups
python -m hunter restore BACKUP.db      # put a backup back
python -m hunter schedule --at 01:00    # daily hunt + backup at 01:00 UTC, forever (Docker)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

from .categories import find_category
from .db import Database
from .engine import Hunter
from .jobs import NoSources, run_hunt
from .payments import PLAN_TIERS
from .pricing import PricingConfig
from .sources.sample import SampleData

log = logging.getLogger("hunter")


def cmd_hunt(args) -> int:
    cats = [find_category(k) for k in args.categories.split(",")] if args.categories else None
    cfg = PricingConfig.from_env()
    if args.market:
        cfg = cfg.for_market(args.market)
    db = Database(args.db)
    if getattr(args, "if_empty", False) and db.latest_hunt_time():
        print("There is already a hunt; skipped (--if-empty).")
        return 0
    try:
        hunt_id, data, result = run_hunt(
            db, cfg, sample=args.sample, categories=cats, per_category=args.per_category
        )
    except NoSources as e:
        print(f"{e} Or use --sample.", file=sys.stderr)
        return 2
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
    until = Database(args.db).grant(args.email.lower(), args.days, args.plan)
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


def backup(db_path: str, out_dir: str, keep: int) -> Path:
    """Copy the database to OUT_DIR/hunter-<time>.db and keep only the newest KEEP copies."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = Path(out_dir) / f"hunter-{stamp}.db"
    Database(db_path).backup(dest)
    for old in sorted(Path(out_dir).glob("hunter-*.db"))[:-keep]:
        old.unlink()
    return dest


def cmd_backup(args) -> int:
    print(f"Wrote {backup(args.db, args.out, args.keep)}")
    return 0


def cmd_restore(args) -> int:
    Database(args.db).restore(args.backup)
    print(f"Restored {args.db} from {args.backup}")
    return 0


def next_run(at: str, now: datetime) -> datetime:
    hour, minute = (int(x) for x in at.split(":"))
    run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return run if run > now else run + timedelta(days=1)


def cmd_schedule(args) -> int:
    """Every day at --at (UTC): the hunt, then a database backup. Runs until stopped."""
    first = True
    while True:
        if not (first and args.now):
            now = datetime.now(timezone.utc)
            run = next_run(args.at, now)
            log.info("next hunt at %s UTC", run.strftime("%Y-%m-%d %H:%M"))
            time.sleep((run - now).total_seconds())
        first = False
        for job in (lambda: cmd_hunt(args), lambda: backup(args.db, args.backup_dir, args.keep)):
            try:
                job()
            except Exception:  # one bad night mustn't stop the schedule
                log.exception("scheduled job failed")


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
    backups_default = os.environ.get("HUNTER_BACKUPS", "hunter-data/backups")

    parser = argparse.ArgumentParser(
        prog="python -m hunter", description="Product hunter for the store's sellers"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    def hunt_args(p):
        p.add_argument("--sample", action="store_true", help="use the bundled sample data")
        p.add_argument("--categories", help="comma separated category keys (default: all allowed)")
        p.add_argument("--per-category", type=int, default=20)
        p.add_argument(
            "--market", choices=["prepaid", "cod"], help="default: HUNTER_MARKET or prepaid"
        )
        p.add_argument("--db", default=db_default)
        p.add_argument("--json", help="also write the hunt to this JSON file")

    p = sub.add_parser("hunt", help="find products and save the hunt")
    hunt_args(p)
    p.add_argument("--if-empty", action="store_true", help="only if there's no hunt yet")
    p.set_defaults(func=cmd_hunt)

    p = sub.add_parser("schedule", help="hunt and back up every day at a fixed time (UTC)")
    hunt_args(p)
    p.add_argument("--at", default="01:00", help="HH:MM in UTC (01:00 UTC is 04:30 in Tehran)")
    p.add_argument("--now", action="store_true", help="also run once right away")
    p.add_argument("--backup-dir", default=backups_default)
    p.add_argument("--keep", type=int, default=14, help="backups to keep")
    p.set_defaults(func=cmd_schedule)

    p = sub.add_parser("backup", help="copy the database (safe while the site runs)")
    p.add_argument("--db", default=db_default)
    p.add_argument("--out", default=backups_default)
    p.add_argument("--keep", type=int, default=14, help="backups to keep")
    p.set_defaults(func=cmd_backup)

    p = sub.add_parser("serve", help="run the website")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8100)
    p.add_argument("--db")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("grant", help="activate or extend a seller's subscription")
    p.add_argument("email")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--plan", choices=[t["id"] for t in PLAN_TIERS], default="basic")
    p.add_argument("--db", default=db_default)
    p.set_defaults(func=cmd_grant)

    p = sub.add_parser("make-admin", help="let a seller see everything without paying")
    p.add_argument("email")
    p.add_argument("--db", default=db_default)
    p.set_defaults(func=cmd_make_admin)

    p = sub.add_parser("restore", help="replace the database with a backup")
    p.add_argument("backup")
    p.add_argument("--db", default=db_default)
    p.set_defaults(func=cmd_restore)

    p = sub.add_parser("preview", help="write a self-contained demo page of the sample hunt")
    p.add_argument("out")
    p.set_defaults(func=cmd_preview)

    args = parser.parse_args(argv)
    return args.func(args)
