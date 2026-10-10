"""Aggregate usage without storing names, URLs or IP addresses.

SQLite for a persistent server volume; Cloudflare's durable storage in webhook mode.
Analytics errors never prevent a download. Failed writes are logged, not fabricated.
"""
import hashlib
from contextlib import contextmanager
import hmac
import json
import logging
import os
import sqlite3
import time
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

log = logging.getLogger(__name__)
SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, actor TEXT NOT NULL,
 kind TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_window ON events(at,source,kind);
CREATE TABLE IF NOT EXISTS installations (actor TEXT PRIMARY KEY, active INTEGER NOT NULL);
"""


def identity(source, value):
    key = os.getenv('ANALYTICS_SALT') or os.getenv('BOT_TOKEN') or os.getenv('ADMIN_TOKEN') or 'local-only'
    return hmac.new(key.encode(), f'{source}:{value}'.encode(), hashlib.sha256).hexdigest()


def summarize(query, now=None):
    now = int(time.time()) if now is None else now
    def count(where, *args, distinct=False):
        expression = 'COUNT(DISTINCT actor)' if distinct else 'COUNT(*)'
        return query(f'SELECT {expression} AS n FROM events WHERE {where}', args)[0]['n']
    metrics = {}
    for source in ('telegram', 'web'):
        metrics[source] = {
            'total_users': count("source=? AND kind='activity'", source, distinct=True),
            'active_24h': count("source=? AND kind='activity' AND at>=?", source, now-86400, distinct=True),
            'active_30d': count("source=? AND kind='activity' AND at>=?", source, now-30*86400, distinct=True),
            'requests': count("source=? AND kind='request'", source),
            'completed': count("source=? AND kind='completed'", source),
            'failed': count("source=? AND kind='failed'", source),
        }
    metrics['web']['visitors'] = count("source='web' AND kind='visit'", distinct=True)
    metrics['telegram']['starts'] = count("source='telegram' AND kind='start'", distinct=True)
    metrics['telegram']['active_groups_channels'] = query('SELECT COUNT(*) AS n FROM installations WHERE active=1', ())[0]['n']
    metrics['recording_since'] = query('SELECT MIN(at) AS at FROM events', ())[0]['at']
    active = metrics['telegram']['active_30d']
    metrics['subscription'] = {'threshold': 10000, 'basis': 'telegram_active_30d',
        'ready_for_review': active >= 10000, 'monthly_price_gbp': 1,
        'illustrative_gross_gbp': active, 'billing_enabled': False}
    return metrics


class Usage:
    def __init__(self, path=None):
        self.path = Path(path or os.getenv('ANALYTICS_DB', 'data/usage.sqlite3'))
        self.remote = os.getenv('ANALYTICS_URL', '').rstrip('/')
        self.key = os.getenv('ADMIN_TOKEN', '')
        if not self.remote:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.connect() as db:
                db.executescript(SCHEMA)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def request(self, payload=None):
        req = Request(self.remote, data=json.dumps(payload).encode() if payload else None,
            headers={'Authorization': f'Bearer {self.key}', 'Content-Type': 'application/json'})
        with urlopen(req, timeout=5) as response:
            return json.load(response)

    def record(self, source, actor, kind, event_id=None):
        if actor is None:
            return
        payload = dict(id=event_id or uuid.uuid4().hex, source=source,
            actor=identity(source, actor), kind=kind, at=int(time.time()))
        try:
            if self.remote:
                self.request(payload)
                return
            with self.connect() as db:
                if db.execute('SELECT id FROM events WHERE id=?', (payload['id'],)).fetchone():
                    return
                db.execute('INSERT OR IGNORE INTO events VALUES (:id,:source,:actor,:kind,:at)', payload)
                if kind in ('installed', 'removed'):
                    db.execute('INSERT INTO installations VALUES (?,?) ON CONFLICT(actor) DO UPDATE SET active=excluded.active',
                        (payload['actor'], int(kind == 'installed')))
        except Exception:
            log.exception('Usage write failed')

    def summary(self):
        if self.remote:
            return self.request()
        with self.connect() as db:
            return summarize(lambda sql, args: [dict(row) for row in db.execute(sql, args)])
