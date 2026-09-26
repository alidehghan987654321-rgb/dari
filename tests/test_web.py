import threading
import time

import pytest
from fastapi.testclient import TestClient

import web
from downloader import DownloadResult

MB = 1024 * 1024
SETTINGS = web.Settings(
    max_bytes=MB,
    max_height=720,
    max_items=10,
    max_concurrent=2,
    file_ttl=60,
    cookies_file=None,
    proxy=None,
    bot_token=None,
)


@pytest.fixture
def client():
    with TestClient(web.create_app(SETTINGS)) as c:
        yield c


@pytest.fixture
def any_link_is_video(monkeypatch):
    """Treat the local test server's links like Instagram/TikTok links."""
    monkeypatch.setattr(web, "is_video_link", lambda url: True)


def wait_for(client, job_id, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_home_page_and_assets(client):
    page = client.get("/")
    assert page.status_code == 200
    assert 'lang="fa"' in page.text
    for path in ("/app.css", "/app.js", "/fonts/Vazirmatn-Bold.woff2", "/assets/avatar.png"):
        assert client.get(path).status_code == 200, path


def test_info(client):
    assert client.get("/api/info").json() == {"bot_username": None, "max_mb": 1}


@pytest.mark.parametrize("url", ["", "hello", "ftp://x.com/a", "https://github.com/a/b"])
def test_rejects_links_that_are_not_videos(client, url):
    res = client.post("/api/jobs", json={"url": url})
    assert res.status_code == 400
    assert res.json()["detail"]


def test_download_and_fetch_file(client, server, any_link_is_video):
    res = client.post("/api/jobs", json={"url": f"{server}/small.mp4"})
    assert res.status_code == 202
    job = wait_for(client, res.json()["id"])

    assert job["status"] == "done"
    (file,) = job["files"]
    assert file["kind"] == "video"
    assert file["size"] == 200_000
    assert file["source"] == f"{server}/small.mp4"

    got = client.get(file["url"])
    assert got.status_code == 200
    assert len(got.content) == 200_000
    assert got.headers["content-disposition"].startswith("attachment;")
    inline = client.get(file["url"], params={"inline": 1})
    assert inline.headers["content-disposition"].startswith("inline;")
    ranged = client.get(file["url"], headers={"Range": "bytes=0-99"})
    assert ranged.status_code == 206  # lets the video player seek
    assert len(ranged.content) == 100


def test_links_without_scheme_are_accepted(client, monkeypatch):
    seen = []
    monkeypatch.setattr(web, "is_video_link", lambda url: seen.append(url) or False)
    client.post("/api/jobs", json={"url": "  instagram.com/reel/abc  "})
    assert seen == ["https://instagram.com/reel/abc"]


def test_too_large_file_is_an_error(client, server, any_link_is_video):
    res = client.post("/api/jobs", json={"url": f"{server}/big.mp4"})
    job = wait_for(client, res.json()["id"])
    assert job["status"] == "error"
    assert "مگابایت" in job["error"]
    assert job["files"] == []


def test_unknown_job_and_file(client):
    assert client.get("/api/jobs/nope").status_code == 404
    assert client.get("/files/nope/0").status_code == 404


def test_each_visitor_gets_limited_parallel_downloads(client, monkeypatch, any_link_is_video):
    release = threading.Event()

    def slow_download(*args, **kwargs):
        release.wait(10)
        return DownloadResult()

    monkeypatch.setattr(web, "download", slow_download)
    try:
        for _ in range(web.MAX_JOBS_PER_IP):
            assert client.post("/api/jobs", json={"url": "https://a/"}).status_code == 202
        res = client.post("/api/jobs", json={"url": "https://a/"})
        assert res.status_code == 429
    finally:
        release.set()


def test_finished_jobs_expire_and_their_files_are_deleted(client, server, any_link_is_video):
    job_id = client.post("/api/jobs", json={"url": f"{server}/small.mp4"}).json()["id"]
    wait_for(client, job_id)
    job = client.app.state.jobs[job_id]
    assert job.dir.exists()

    client.app.state.sweep(time.monotonic() + SETTINGS.file_ttl + 1)
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
    assert not job.dir.exists()


def test_download_name():
    from pathlib import Path

    from downloader import MediaFile

    media = MediaFile(Path("x/abc.mp4"), "video", title='Sunset / "beach" <3 🌅 غروب')
    assert web.download_name(media, 0) == "Sunset beach 3 غروب.mp4"
    assert web.download_name(MediaFile(Path("x/abc.mp4"), "video"), 1) == "video-2.mp4"
