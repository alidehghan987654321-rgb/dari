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
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    categories TEXT NOT NULL DEFAULT '[]',
    budget_usd REAL NOT NULL DEFAULT 1000,
    paid_until TEXT,
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
        with self.tx() as db:
            db.executescript(SCHEMA)

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
        self, user_id: int, *, name: str, phone: str, categories: list[str], budget_usd: float
    ) -> None:
        with self.tx() as db:
            db.execute(
                "UPDATE users SET name = ?, phone = ?, categories = ?, budget_usd = ? WHERE id = ?",
                (name, phone, json.dumps(categories), budget_usd, user_id),
            )

    def extend_subscription(self, db: sqlite3.Connection, user_id: int, days: int) -> str:
        row = db.execute("SELECT paid_until FROM users WHERE id = ?", (user_id,)).fetchone()
        start = now()
        if row and row["paid_until"]:
            start = max(start, datetime.fromisoformat(row["paid_until"]))
        until = iso(start + timedelta(days=days))
        db.execute("UPDATE users SET paid_until = ? WHERE id = ?", (until, user_id))
        return until

    def grant(self, email: str, days: int) -> str | None:
        with self.tx() as db:
            row = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
            if not row:
                return None
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
            self.extend_subscription(db, row["user_id"], row["days"])
            return True

    # --- hunts and picks -------------------------------------------------------

    def save_hunt(self, data: dict) -> int:
        """Store a hunt, and remember each find under its links (the listing's and the
        same product's on other markets), so a seller pasting one of them gets the answer
        without new API calls."""
        with self.tx() as db:
            cur = db.execute(
                "INSERT INTO hunts (created_at, data) VALUES (?, ?)",
                (iso(now()), json.dumps(data, ensure_ascii=False)),
            )
            hunt_id = cur.lastrowid
        for c in data.get("candidates", []):
            urls = [c["listing"]["url"], *(m["url"] for m in c.get("matches", []))]
            self.cache([link_key(u) for u in urls if u], c)
        return hunt_id

    def latest_hunt(self) -> tuple[int, dict] | None:
        with self.tx() as db:
            row = db.execute("SELECT id, data FROM hunts ORDER BY id DESC LIMIT 1").fetchone()
        return (row["id"], json.loads(row["data"])) if row else None

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
