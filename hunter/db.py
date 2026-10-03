"""SQLite storage for the website: sellers, sessions, payments, hunts and picks."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .links import link_key

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    national_id TEXT NOT NULL DEFAULT '',  -- for the RhinoMall order sheet
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    categories TEXT NOT NULL DEFAULT '[]',
    budget_usd REAL NOT NULL DEFAULT 1000,
    paid_until TEXT,
    plan TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    plan TEXT NOT NULL,
    days INTEGER NOT NULL,
    amount_rial INTEGER NOT NULL,
    gateway TEXT NOT NULL,
    authority TEXT UNIQUE,
    status TEXT NOT NULL,
    ref_id TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT
);
CREATE TABLE IF NOT EXISTS hunts (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    url TEXT NOT NULL,
    status TEXT NOT NULL,  -- queued, running, done, failed
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS analyses_user ON analyses (user_id, id);
CREATE TABLE IF NOT EXISTS link_cache (
    key TEXT PRIMARY KEY,  -- hunter.links.link_key
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offer_cache (
    url TEXT PRIMARY KEY,  -- a 1688 offer page, as shown on our site
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS names_fa (
    key TEXT PRIMARY KEY,  -- source:id of a listing
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS picks (
    hunt_id INTEGER NOT NULL REFERENCES hunts(id),
    candidate_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (hunt_id, candidate_id, user_id)
);
CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    data TEXT NOT NULL,  -- the order line's inputs (hunter.orders.OrderItem), priced on read
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_user ON requests (user_id, id);
-- The growing catalog: every find kept, deduplicated by its id, never deleted. The daily
-- hunt adds to it (updates price/verdict when a product is seen again).
CREATE TABLE IF NOT EXISTS catalog (
    id TEXT PRIMARY KEY,            -- candidate id, "source:listing_id"
    category TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0,
    profit_usd REAL NOT NULL DEFAULT 0,
    capital_usd REAL NOT NULL DEFAULT 0,
    title_fa TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,             -- the full candidate (hunter.models.Candidate.to_dict)
    first_found TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    times_found INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS catalog_browse ON catalog (verdict, category, score);
CREATE INDEX IF NOT EXISTS catalog_updated ON catalog (updated_at);
-- A product given to a seller as their exclusive pick (option B): capped per product so
-- sellers don't all chase the same item. Spans the whole catalog, not one hunt.
CREATE TABLE IF NOT EXISTS catalog_picks (
    candidate_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (candidate_id, user_id)
);
CREATE INDEX IF NOT EXISTS catalog_picks_user ON catalog_picks (user_id);
"""


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
            # The site and the daily hunt write at the same time; WAL lets readers go on.
            conn = sqlite3.connect(self.path, timeout=30)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.close()
        with self.tx() as db:
            db.executescript(SCHEMA)
            # Databases made before plans had tiers, or before the order sheet.
            columns = {r["name"] for r in db.execute("PRAGMA table_info(users)")}
            if "plan" not in columns:
                db.execute("ALTER TABLE users ADD COLUMN plan TEXT")
            if "national_id" not in columns:
                db.execute("ALTER TABLE users ADD COLUMN national_id TEXT NOT NULL DEFAULT ''")

    @contextmanager
    def tx(self):
        """A connection in a transaction: committed on success, rolled back on error."""
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    # --- users -----------------------------------------------------------------

    def create_user(self, email: str, name: str, phone: str, password_hash: str) -> int:
        with self.tx() as db:
            cur = db.execute(
                "INSERT INTO users (email, name, phone, password_hash, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (email, name, phone, password_hash, iso(now())),
            )
            return cur.lastrowid

    def user(self, user_id: int) -> dict[str, Any] | None:
        with self.tx() as db:
            row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _user(row)

    def user_by_email(self, email: str) -> dict[str, Any] | None:
        with self.tx() as db:
            row = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return _user(row)

    def update_profile(
        self,
        user_id: int,
        *,
        name: str,
        phone: str,
        categories: list[str],
        budget_usd: float,
        national_id: str = "",
    ) -> None:
        with self.tx() as db:
            db.execute(
                "UPDATE users SET name = ?, phone = ?, categories = ?, budget_usd = ?,"
                " national_id = ? WHERE id = ?",
                (name, phone, json.dumps(categories), budget_usd, national_id, user_id),
            )

    def extend_subscription(self, db: sqlite3.Connection, user_id: int, days: int) -> str:
        row = db.execute("SELECT paid_until FROM users WHERE id = ?", (user_id,)).fetchone()
        start = now()
        if row and row["paid_until"]:
            start = max(start, datetime.fromisoformat(row["paid_until"]))
        until = iso(start + timedelta(days=days))
        db.execute("UPDATE users SET paid_until = ? WHERE id = ?", (until, user_id))
        return until

    def grant(self, email: str, days: int, plan: str | None = None) -> str | None:
        with self.tx() as db:
            row = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
            if not row:
                return None
            if plan:
                db.execute("UPDATE users SET plan = ? WHERE id = ?", (plan, row["id"]))
            return self.extend_subscription(db, row["id"], days)

    def make_admin(self, email: str) -> bool:
        with self.tx() as db:
            cur = db.execute("UPDATE users SET is_admin = 1 WHERE email = ?", (email,))
            return cur.rowcount > 0

    # --- sessions --------------------------------------------------------------

    def create_session(self, token: str, user_id: int, days: int = 30) -> None:
        with self.tx() as db:
            db.execute("DELETE FROM sessions WHERE expires_at < ?", (iso(now()),))
            db.execute(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
                (token, user_id, iso(now() + timedelta(days=days))),
            )

    def session_user(self, token: str) -> dict[str, Any] | None:
        with self.tx() as db:
            row = db.execute(
                "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id"
                " WHERE sessions.token = ? AND sessions.expires_at > ?",
                (token, iso(now())),
            ).fetchone()
        return _user(row)

    def delete_session(self, token: str) -> None:
        with self.tx() as db:
            db.execute("DELETE FROM sessions WHERE token = ?", (token,))

    # --- payments --------------------------------------------------------------

    def create_payment(
        self, user_id: int, plan: str, days: int, amount_rial: int, gateway: str
    ) -> int:
        with self.tx() as db:
            cur = db.execute(
                "INSERT INTO payments (user_id, plan, days, amount_rial, gateway, status, created_at)"
                " VALUES (?, ?, ?, ?, ?, 'new', ?)",
                (user_id, plan, days, amount_rial, gateway, iso(now())),
            )
            return cur.lastrowid

    def set_authority(self, payment_id: int, authority: str) -> None:
        with self.tx() as db:
            db.execute(
                "UPDATE payments SET authority = ?, status = 'pending' WHERE id = ?",
                (authority, payment_id),
            )

    def payment_by_authority(self, authority: str) -> dict[str, Any] | None:
        with self.tx() as db:
            row = db.execute("SELECT * FROM payments WHERE authority = ?", (authority,)).fetchone()
        return dict(row) if row else None

    def mark_failed(self, payment_id: int) -> None:
        with self.tx() as db:
            db.execute(
                "UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'",
                (payment_id,),
            )

    def mark_paid(self, payment_id: int, ref_id: str) -> bool:
        """Record a verified payment and extend the subscription, once."""
        with self.tx() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM payments WHERE id = ?", (payment_id,)).fetchone()
            if not row or row["status"] == "paid":
                return False
            db.execute(
                "UPDATE payments SET status = 'paid', ref_id = ?, paid_at = ? WHERE id = ?",
                (ref_id, iso(now()), payment_id),
            )
            db.execute("UPDATE users SET plan = ? WHERE id = ?", (row["plan"], row["user_id"]))
            self.extend_subscription(db, row["user_id"], row["days"])
            return True

    # --- hunts and picks -------------------------------------------------------

    def save_hunt(self, data: dict) -> int:
        """Store a hunt, and remember each find under its links (the listing's and the
        same product's on other markets), so a seller pasting one of them gets the answer
        without new API calls."""
        previous = self.latest_hunt()
        seen = {c["offer"]["id"] for c in previous[1]["candidates"]} if previous else set()
        for c in data.get("candidates", []):
            c["is_new"] = c["offer"]["id"] not in seen
        with self.tx() as db:
            cur = db.execute(
                "INSERT INTO hunts (created_at, data) VALUES (?, ?)",
                (iso(now()), json.dumps(data, ensure_ascii=False)),
            )
            hunt_id = cur.lastrowid
        for c in data.get("candidates", []):
            urls = [c["listing"]["url"], *(m["url"] for m in c.get("matches", []))]
            self.cache([link_key(u) for u in urls if u], c)
        self.upsert_catalog(data.get("candidates", []))  # grows the permanent catalog
        return hunt_id

    def latest_hunt(self) -> tuple[int, dict] | None:
        with self.tx() as db:
            row = db.execute("SELECT id, data FROM hunts ORDER BY id DESC LIMIT 1").fetchone()
        return (row["id"], json.loads(row["data"])) if row else None

    def latest_hunt_time(self) -> str | None:
        with self.tx() as db:
            row = db.execute("SELECT created_at FROM hunts ORDER BY id DESC LIMIT 1").fetchone()
        return row["created_at"] if row else None

    def backup(self, dest: str | Path) -> None:
        """A consistent copy of the whole database, safe while the site is running."""
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        src, out = sqlite3.connect(self.path, timeout=30), sqlite3.connect(str(dest))
        try:
            src.backup(out)
        finally:
            out.close()
            src.close()

    def restore(self, src: str | Path) -> None:
        """Replace the whole database with a backup, through SQLite (safe with WAL)."""
        if not Path(src).is_file():
            raise FileNotFoundError(src)
        backup, out = sqlite3.connect(str(src)), sqlite3.connect(self.path, timeout=30)
        try:
            backup.backup(out)
        finally:
            out.close()
            backup.close()

    def picks(self, hunt_id: int, user_id: int) -> list[str]:
        with self.tx() as db:
            rows = db.execute(
                "SELECT candidate_id FROM picks WHERE hunt_id = ? AND user_id = ? ORDER BY rowid",
                (hunt_id, user_id),
            ).fetchall()
        return [r["candidate_id"] for r in rows]

    @contextmanager
    def picking(self, hunt_id: int):
        """Hand out picks one seller at a time: yields (taken counts, save function)."""
        with self.tx() as db:
            db.execute("BEGIN IMMEDIATE")
            taken: dict[str, int] = {}
            for r in db.execute(
                "SELECT candidate_id, COUNT(*) AS n FROM picks WHERE hunt_id = ? GROUP BY candidate_id",
                (hunt_id,),
            ):
                taken[r["candidate_id"]] = r["n"]

            def save(user_id: int, candidate_ids: list[str]) -> None:
                db.executemany(
                    "INSERT OR IGNORE INTO picks (hunt_id, candidate_id, user_id, created_at)"
                    " VALUES (?, ?, ?, ?)",
                    [(hunt_id, cid, user_id, iso(now())) for cid in candidate_ids],
                )

            yield taken, save

    # --- the growing catalog ---------------------------------------------------

    _CATALOG_SORTS = {
        "new": "updated_at DESC, score DESC",
        "score": "score DESC, updated_at DESC",
        "profit": "profit_usd DESC, score DESC",
        "capital": "capital_usd ASC, score DESC",
    }

    def upsert_catalog(self, candidates: list[dict[str, Any]], run_at: str | None = None) -> None:
        """Add this hunt's finds to the catalog; a product already there keeps its first-found
        date and gets its price, verdict and score refreshed."""
        at = run_at or iso(now())
        rows = [
            (
                c["id"],
                c.get("category", ""),
                c.get("verdict", ""),
                int(c.get("score", 0) or 0),
                float((c.get("pricing") or {}).get("profit_usd", 0) or 0),
                float(c.get("starter_capital_usd", 0) or 0),
                c.get("title_fa", ""),
                json.dumps(c, ensure_ascii=False),
                at,
                at,
            )
            for c in candidates
            if c.get("id")
        ]
        with self.tx() as db:
            db.executemany(
                "INSERT INTO catalog (id, category, verdict, score, profit_usd, capital_usd,"
                " title_fa, data, first_found, updated_at, times_found) VALUES (?,?,?,?,?,?,?,?,?,?,1)"
                " ON CONFLICT(id) DO UPDATE SET category=excluded.category, verdict=excluded.verdict,"
                " score=excluded.score, profit_usd=excluded.profit_usd, capital_usd=excluded.capital_usd,"
                " title_fa=excluded.title_fa, data=excluded.data, updated_at=excluded.updated_at,"
                " times_found=catalog.times_found+1",
                rows,
            )

    def catalog_page(
        self,
        *,
        category: str = "all",
        verdict: str = "all",
        sort: str = "new",
        fresh_hours: float | None = None,
        q: str = "",
        limit: int = 24,
        offset: int = 0,
    ) -> dict[str, Any]:
        where, args = [], []
        if category and category != "all":
            where.append("category = ?")
            args.append(category)
        if verdict and verdict != "all":
            where.append("verdict = ?")
            args.append(verdict)
        if fresh_hours:
            where.append("first_found > ?")
            args.append(iso(now() - timedelta(hours=fresh_hours)))
        if q:
            where.append("(title_fa LIKE ? OR data LIKE ?)")
            args += [f"%{q}%", f"%{q}%"]
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        order = self._CATALOG_SORTS.get(sort, self._CATALOG_SORTS["new"])
        cutoff = iso(now() - timedelta(hours=24))
        with self.tx() as db:
            rows = db.execute(
                f"SELECT data, first_found, updated_at, times_found FROM catalog{clause}"
                f" ORDER BY {order} LIMIT ? OFFSET ?",
                (*args, limit, offset),
            ).fetchall()
            total = db.execute(f"SELECT COUNT(*) AS n FROM catalog{clause}", args).fetchone()["n"]
            taken = {
                r["candidate_id"]: r["n"]
                for r in db.execute(
                    "SELECT candidate_id, COUNT(*) AS n FROM catalog_picks GROUP BY candidate_id"
                )
            }
        items = []
        for r in rows:
            c = json.loads(r["data"])
            c["first_found"], c["updated_at"] = r["first_found"], r["updated_at"]
            c["times_found"] = r["times_found"]
            c["is_new"] = r["first_found"] >= cutoff
            c["taken"] = taken.get(c["id"], 0)
            items.append(c)
        return {"items": items, "total": total, "offset": offset, "limit": limit}

    def catalog_counts(self) -> dict[str, Any]:
        with self.tx() as db:
            verd = {
                r["verdict"]: r["n"]
                for r in db.execute("SELECT verdict, COUNT(*) AS n FROM catalog GROUP BY verdict")
            }
            cats = [
                r["category"]
                for r in db.execute(
                    "SELECT category, COUNT(*) AS n FROM catalog WHERE category <> ''"
                    " GROUP BY category ORDER BY n DESC"
                )
            ]
            total = db.execute("SELECT COUNT(*) AS n FROM catalog").fetchone()["n"]
            fresh = db.execute(
                "SELECT COUNT(*) AS n FROM catalog WHERE first_found > ?",
                (iso(now() - timedelta(hours=24)),),
            ).fetchone()["n"]
        return {
            "total": total,
            "green": verd.get("green", 0),
            "yellow": verd.get("yellow", 0),
            "red": verd.get("red", 0),
            "new": fresh,
            "categories": cats,
        }

    def catalog_for_picks(self, categories: list[str], limit: int = 400) -> list[dict[str, Any]]:
        """The best green/yellow finds to hand out as a seller's exclusive picks."""
        q = "SELECT data FROM catalog WHERE verdict IN ('green','yellow')"
        args: list[Any] = []
        if categories:
            q += f" AND category IN ({','.join('?' * len(categories))})"
            args += list(categories)
        q += " ORDER BY score DESC, updated_at DESC LIMIT ?"
        args.append(limit)
        with self.tx() as db:
            rows = db.execute(q, args).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def catalog_items(self, ids: list[str]) -> list[dict[str, Any]]:
        if not ids:
            return []
        with self.tx() as db:
            rows = db.execute(
                f"SELECT data FROM catalog WHERE id IN ({','.join('?' * len(ids))})", ids
            ).fetchall()
        by_id = {}
        for r in rows:
            c = json.loads(r["data"])
            by_id[c["id"]] = c
        return [by_id[i] for i in ids if i in by_id]

    def my_catalog_picks(self, user_id: int) -> list[str]:
        with self.tx() as db:
            rows = db.execute(
                "SELECT candidate_id FROM catalog_picks WHERE user_id = ? ORDER BY rowid",
                (user_id,),
            ).fetchall()
        return [r["candidate_id"] for r in rows]

    @contextmanager
    def picking_catalog(self):
        """Hand out exclusive picks from the catalog: yields (taken counts, save function)."""
        with self.tx() as db:
            db.execute("BEGIN IMMEDIATE")
            taken: dict[str, int] = {
                r["candidate_id"]: r["n"]
                for r in db.execute(
                    "SELECT candidate_id, COUNT(*) AS n FROM catalog_picks GROUP BY candidate_id"
                )
            }

            def save(user_id: int, candidate_ids: list[str]) -> None:
                db.executemany(
                    "INSERT OR IGNORE INTO catalog_picks (candidate_id, user_id, created_at)"
                    " VALUES (?, ?, ?)",
                    [(cid, user_id, iso(now())) for cid in candidate_ids],
                )

            yield taken, save

    # --- order cart (ثبت درخواست): products a seller wants to order -------------

    def add_request(self, user_id: int, data: dict) -> int:
        at = iso(now())
        with self.tx() as db:
            cur = db.execute(
                "INSERT INTO requests (user_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (user_id, json.dumps(data, ensure_ascii=False), at, at),
            )
            return cur.lastrowid

    def requests(self, user_id: int) -> list[dict[str, Any]]:
        with self.tx() as db:
            rows = db.execute(
                "SELECT * FROM requests WHERE user_id = ? ORDER BY id", (user_id,)
            ).fetchall()
        return [
            {
                "id": r["id"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "data": json.loads(r["data"]),
            }
            for r in rows
        ]

    def request(self, user_id: int, request_id: int) -> dict[str, Any] | None:
        with self.tx() as db:
            row = db.execute(
                "SELECT * FROM requests WHERE id = ? AND user_id = ?", (request_id, user_id)
            ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "data": json.loads(row["data"]),
        }

    def update_request(self, user_id: int, request_id: int, data: dict) -> bool:
        with self.tx() as db:
            cur = db.execute(
                "UPDATE requests SET data = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                (json.dumps(data, ensure_ascii=False), iso(now()), request_id, user_id),
            )
            return cur.rowcount > 0

    def delete_request(self, user_id: int, request_id: int) -> bool:
        with self.tx() as db:
            cur = db.execute(
                "DELETE FROM requests WHERE id = ? AND user_id = ?", (request_id, user_id)
            )
            return cur.rowcount > 0

    def clear_requests(self, user_id: int) -> int:
        with self.tx() as db:
            cur = db.execute("DELETE FROM requests WHERE user_id = ?", (user_id,))
            return cur.rowcount

    # --- product links sellers bring -------------------------------------------

    def queue_analyses(self, user_id: int, urls: list[str]) -> list[int]:
        with self.tx() as db:
            return [
                db.execute(
                    "INSERT INTO analyses (user_id, url, status, created_at) VALUES (?, ?, 'queued', ?)",
                    (user_id, url, iso(now())),
                ).lastrowid
                for url in urls
            ]

    def analyses_since(self, user_id: int, days: int = 30) -> int:
        since = iso(now() - timedelta(days=days))
        with self.tx() as db:
            row = db.execute(
                "SELECT COUNT(*) AS n FROM analyses WHERE user_id = ? AND created_at > ?",
                (user_id, since),
            ).fetchone()
        return row["n"]

    def set_analysis(
        self, analysis_id: int, status: str, result: dict | None = None, error: str | None = None
    ) -> None:
        done = status in ("done", "failed")
        with self.tx() as db:
            db.execute(
                "UPDATE analyses SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?",
                (
                    status,
                    json.dumps(result, ensure_ascii=False) if result is not None else None,
                    error,
                    iso(now()) if done else None,
                    analysis_id,
                ),
            )

    def analyses(self, user_id: int, limit: int = 30) -> list[dict[str, Any]]:
        with self.tx() as db:
            rows = db.execute(
                "SELECT * FROM analyses WHERE user_id = ? ORDER BY id DESC LIMIT ?",
                (user_id, limit),
            ).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["result"] = json.loads(item["result"]) if item["result"] else None
            out.append(item)
        return out

    def cached(self, key: str, max_age_hours: float) -> dict | None:
        with self.tx() as db:
            row = db.execute(
                "SELECT result FROM link_cache WHERE key = ? AND created_at > ?",
                (key, iso(now() - timedelta(hours=max_age_hours))),
            ).fetchone()
        return json.loads(row["result"]) if row else None

    def cache(self, keys: list[str], result: dict) -> None:
        text = json.dumps(result, ensure_ascii=False)
        with self.tx() as db:
            db.executemany(
                "INSERT OR REPLACE INTO link_cache (key, result, created_at) VALUES (?, ?, ?)",
                [(k, text, iso(now())) for k in dict.fromkeys(keys)],
            )

    def cached_offer(self, url: str, max_age_hours: float) -> dict | None:
        with self.tx() as db:
            row = db.execute(
                "SELECT data FROM offer_cache WHERE url = ? AND created_at > ?",
                (url, iso(now() - timedelta(hours=max_age_hours))),
            ).fetchone()
        return json.loads(row["data"]) if row else None

    def cache_offer(self, url: str, data: dict) -> None:
        with self.tx() as db:
            db.execute(
                "INSERT OR REPLACE INTO offer_cache (url, data, created_at) VALUES (?, ?, ?)",
                (url, json.dumps(data, ensure_ascii=False), iso(now())),
            )

    def names(self, keys: list[str]) -> dict[str, str]:
        if not keys:
            return {}
        with self.tx() as db:
            rows = db.execute(
                f"SELECT key, name FROM names_fa WHERE key IN ({','.join('?' * len(keys))})", keys
            ).fetchall()
        return {r["key"]: r["name"] for r in rows}

    def save_names(self, names: dict[str, str]) -> None:
        with self.tx() as db:
            db.executemany(
                "INSERT OR REPLACE INTO names_fa (key, name) VALUES (?, ?)", list(names.items())
            )

    def fail_unfinished_analyses(self) -> int:
        """After a restart, links that were still waiting can't finish: mark them failed so
        the seller can send them again."""
        with self.tx() as db:
            cur = db.execute(
                "UPDATE analyses SET status = 'failed', error = 'interrupted', finished_at = ?"
                " WHERE status IN ('queued', 'running')",
                (iso(now()),),
            )
            return cur.rowcount


def _user(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    user = dict(row)
    user["categories"] = json.loads(user["categories"] or "[]")
    return user


def is_active(user: dict[str, Any]) -> bool:
    until = user.get("paid_until")
    return bool(user.get("is_admin")) or bool(until and datetime.fromisoformat(until) > now())
