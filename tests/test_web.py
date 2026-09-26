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
    assert 'lang="en"' in page.text  # i18n.js switches to Persian for Persian browsers
    assets = ("/app.css", "/app.js", "/i18n.js", "/fonts/Vazirmatn-Bold.woff2")
    for path in (*assets, "/assets/avatar.png", "/assets/banner-en.png"):
        assert client.get(path).status_code == 200, path


def test_info(client):
    assert client.get("/api/info").json() == {"bot_username": None, "max_mb": 1}


@pytest.mark.parametrize("url", ["", "hello", "ftp://x.com/a", "https://github.com/a/b"])
def test_rejects_links_that_are_not_videos(client, url):
    res = client.post("/api/jobs", json={"url": url})
    assert res.status_code == 400
    assert res.json()["detail"] in ("bad_link", "unsupported_link")


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
    assert job["error"] == "too_large"
    assert job["error_details"] == {"limit_mb": 1}
    assert job["files"] == []


def test_unknown_job_and_file(client):
    assert client.get("/api/jobs/nope").json() == {"detail": "not_found"}
    assert client.get("/files/nope/0").status_code == 404


def test_page_texts_exist_in_both_languages(client):
    """Every data-i18n key in the page, and every error code the server sends, is translated."""
    import re

    page = client.get("/").text
    script = client.get("/i18n.js").text
    en_block, fa_block = script.split("    fa: {")
    keys = set(re.findall(r'data-i18n(?:-aria)?="(\w+)"', page))
    keys |= {
        f"err_{code}"
        for code in (
            "bad_link",
            "unsupported_link",
            "too_many_jobs",
            "busy",
            "not_found",
            "unexpected",
            "unsupported",
            "login",
            "private",
            "unavailable",
            "no_video",
            "failed",
            "too_large",
        )
    }
    for key in keys:
        assert re.search(rf"^\s+{key}:", en_block, re.MULTILINE), f"{key} missing in English"
        assert re.search(rf"^\s+{key}:", fa_block, re.MULTILINE), f"{key} missing in Persian"


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
        assert res.json()["detail"] == "too_many_jobs"
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
