"""Running the site for real: the daily schedule and database backups."""

from datetime import datetime, timezone

import pytest

from hunter.cli import backup, main, next_run
from hunter.db import Database


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
