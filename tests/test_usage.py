import time

from fastapi.testclient import TestClient

from usage import Usage
import web


def test_unique_users_windows_persistence_and_privacy(tmp_path, monkeypatch):
    monkeypatch.delenv('ANALYTICS_URL', raising=False)
    monkeypatch.setenv('ANALYTICS_SALT', 'test-salt')
    path = tmp_path / 'usage.db'
    usage = Usage(path)
    usage.record('telegram', '12345', 'activity', 'update-1')
    usage.record('telegram', '12345', 'activity', 'update-1')
    usage.record('telegram', '12345', 'activity', 'update-2')
    usage.record('web', 'browser-one', 'visit')
    usage.record('web', 'browser-one', 'visit')
    usage.record('telegram', '999', 'activity', 'old')
    with usage.connect() as db:
        db.execute('UPDATE events SET at=? WHERE id=?', (int(time.time())-31*86400, 'old'))
    stats = Usage(path).summary()
    assert stats['telegram']['total_users'] == 2
    assert stats['telegram']['active_30d'] == 1
    assert stats['web']['visitors'] == 1
    assert stats['web']['active_30d'] == 0
    with usage.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM events WHERE actor=?', ('12345',)).fetchone()[0] == 0


def test_membership_retries_do_not_restore_removed_group(tmp_path, monkeypatch):
    monkeypatch.delenv('ANALYTICS_URL', raising=False)
    usage = Usage(tmp_path / 'usage.db')
    usage.record('telegram', '-1001', 'installed', 'add')
    assert usage.summary()['telegram']['active_groups_channels'] == 1
    usage.record('telegram', '-1001', 'removed', 'remove')
    usage.record('telegram', '-1001', 'installed', 'add')
    assert usage.summary()['telegram']['active_groups_channels'] == 0


def test_admin_access_and_visitor_cookie(tmp_path, monkeypatch):
    monkeypatch.delenv('ANALYTICS_URL', raising=False)
    monkeypatch.setenv('ANALYTICS_DB', str(tmp_path / 'usage.db'))
    monkeypatch.setenv('ADMIN_TOKEN', 'a-long-test-key')
    monkeypatch.delenv('BOT_TOKEN', raising=False)
    monkeypatch.delenv('BOT_MODE', raising=False)
    with TestClient(web.create_app()) as client:
        assert client.get('/api/admin/stats').status_code == 401
        assert client.get('/api/admin/stats', headers={'Authorization':'Bearer wrong'}).status_code == 401
        client.get('/')
        client.get('/')
        assert client.cookies.get('dari_visitor')
        response = client.get('/api/admin/stats', headers={'Authorization':'Bearer a-long-test-key'})
        assert response.status_code == 200
        assert response.headers['Cache-Control'] == 'no-store'
        assert response.json()['web']['visitors'] == 1
        assert client.get('/admin.html').status_code == 200
    monkeypatch.delenv('ADMIN_TOKEN')
    with TestClient(web.create_app()) as client:
        assert client.get('/api/admin/stats').status_code == 401


def test_goal_never_enables_billing(tmp_path, monkeypatch):
    monkeypatch.delenv('ANALYTICS_URL', raising=False)
    usage = Usage(tmp_path / 'usage.db')
    with usage.connect() as db:
        db.executemany('INSERT INTO events VALUES (?,?,?,?,?)',
            ((str(i),'telegram',str(i),'activity',int(time.time())) for i in range(10000)))
    plan = usage.summary()['subscription']
    assert plan['ready_for_review'] is True
    assert plan['billing_enabled'] is False
    assert plan['illustrative_gross_gbp'] == 10000
