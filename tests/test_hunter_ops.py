"""Running the site for real: the daily schedule and database backups."""

import sqlite3
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from hunter.app import Settings, create_app
from hunter.cli import backup, main, next_run
from hunter.db import Database
from hunter.jobs import daily_hunt
from hunter.pricing import PricingConfig
from hunter.sources.sample import SampleData


def test_backup_is_a_full_copy_and_keeps_the_newest(tmp_path):
    db = tmp_path / "h.db"
    Database(str(db)).create_user("a@example.com", "a", "", "x")
    out = tmp_path / "backups"
    out.mkdir()
    for n in range(3):
        (out / f"hunter-2020010{n}-000000.db").write_bytes(b"")
    dest = backup(str(db), str(out), keep=2)
    assert sorted(p.name for p in out.iterdir()) == ["hunter-20200102-000000.db", dest.name]
    assert Database(str(dest)).user_by_email("a@example.com")


def test_next_run_is_today_or_tomorrow():
    now = datetime(2026, 9, 27, 0, 30, tzinfo=timezone.utc)
    assert next_run("01:00", now) == datetime(2026, 9, 27, 1, 0, tzinfo=timezone.utc)
    assert next_run("00:30", now) == datetime(2026, 9, 28, 0, 30, tzinfo=timezone.utc)


def test_schedule_hunts_then_backs_up(tmp_path, monkeypatch):
    class Stop(Exception):
        pass

    def stop(seconds):
        assert 0 < seconds <= 86400
        raise Stop

    monkeypatch.setattr("hunter.cli.time.sleep", stop)
    db, backups = tmp_path / "h.db", tmp_path / "b"
    with pytest.raises(Stop):  # ran once right away, then waits for tomorrow
        main(["schedule", "--sample", "--now", "--db", str(db), "--backup-dir", str(backups)])
    assert Database(str(db)).latest_hunt_time()
    assert len(list(backups.glob("hunter-*.db"))) == 1


def test_restore_puts_a_backup_back(tmp_path):
    db = Database(str(tmp_path / "h.db"))
    db.create_user("kept@example.com", "a", "", "x")
    saved = backup(db.path, str(tmp_path / "b"), keep=5)
    db.create_user("later@example.com", "b", "", "x")
    assert main(["restore", str(saved), "--db", db.path]) == 0
    assert db.user_by_email("kept@example.com") and not db.user_by_email("later@example.com")


def hunts(path):
    with sqlite3.connect(path) as conn:
        return conn.execute("SELECT count(*) FROM hunts").fetchone()[0]


@pytest.fixture
def no_data_keys(monkeypatch):
    for name in ("KEEPA_API_KEY", "APIFY_TOKEN"):
        monkeypatch.delenv(name, raising=False)


def test_the_scheduler_starts_the_hunt_with_its_secret_only(tmp_path, no_data_keys):
    path = str(tmp_path / "h.db")
    with TestClient(create_app(Settings(db_path=path, cron_secret="s3cret"))) as c:
        assert c.post("/internal/hunt").status_code == 404
        assert c.post("/internal/hunt", headers={"X-Hunter-Cron": "wrong"}).status_code == 404
        assert hunts(path) == 0
        r = c.post("/internal/hunt", headers={"X-Hunter-Cron": "s3cret"})
        assert r.json() == {"started": True}
        assert hunts(path) == 1  # no data keys yet: the sample hunt, so the site isn't empty
        c.post("/internal/hunt", headers={"X-Hunter-Cron": "s3cret"})
        assert hunts(path) == 1  # and only while there's nothing to show
    with TestClient(create_app(Settings(db_path=path))) as c:  # no secret set: no endpoint
        assert c.post("/internal/hunt", headers={"X-Hunter-Cron": ""}).status_code == 404


def test_daily_hunt_runs_live_when_there_are_sources(tmp_path, monkeypatch):
    sample = SampleData()
    monkeypatch.setattr("hunter.jobs.live_sources", lambda: ([sample], sample))
    db = Database(str(tmp_path / "h.db"))
    assert daily_hunt(db, PricingConfig()).startswith("hunt 1:")
    assert daily_hunt(db, PricingConfig()).startswith("hunt 2:")  # every day, not only once


def test_hunt_if_empty(tmp_path, no_data_keys):
    path = str(tmp_path / "h.db")
    for _ in range(2):
        assert main(["hunt", "--sample", "--if-empty", "--db", path]) == 0
    assert hunts(path) == 1
    assert main(["hunt", "--db", path]) == 2  # live without keys: says what's missing
