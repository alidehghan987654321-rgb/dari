from pathlib import Path

import pytest
from conftest import MB

from downloader import DownloadError, _progress_hook, download, is_video_link, kind_for


@pytest.fixture
def dest(tmp_path):
    d = tmp_path / "out"
    d.mkdir()
    return d


@pytest.mark.parametrize(
    "name, kind",
    [
        ("a.mp4", "video"),
        ("a.MOV", "video"),
        ("a.webm", "document"),
        ("a.m4a", "audio"),
        ("a.jpg", "photo"),
        ("a.zip", "document"),
    ],
)
def test_kind_for(name, kind):
    assert kind_for(Path(name)) == kind


def test_downloads_direct_file(server, dest):
    updates = []
    result = download(f"{server}/small.mp4", dest, max_bytes=MB, progress=updates.append)
    assert len(result.files) == 1
    media = result.files[0]
    assert media.kind == "video"
    assert media.path.parent == dest
    assert media.size == 200_000
    assert media.webpage_url == f"{server}/small.mp4"
    assert result.too_large == 0
    assert updates[-1].downloaded == updates[-1].total == 200_000
    assert updates[-1].fraction == 1


def test_progress_sums_separate_video_and_audio_files():
    updates = []
    hook = _progress_hook(updates.append)
    hook({"status": "finished", "filename": "v.mp4", "downloaded_bytes": 300, "total_bytes": 300})
    hook({"status": "downloading", "filename": "a.m4a", "downloaded_bytes": 50})
    assert updates[-1].total is None  # audio size unknown yet
    hook({"status": "downloading", "filename": "a.m4a", "downloaded_bytes": 60, "total_bytes": 100})
    assert (updates[-1].downloaded, updates[-1].total) == (360, 400)
    assert updates[-1].fraction == 0.9


def test_rejects_file_over_limit(server, dest):
    with pytest.raises(DownloadError) as exc:
        download(f"{server}/big.mp4", dest, max_bytes=MB)
    assert exc.value.code == "too_large"
    assert exc.value.details == {"limit_mb": 1}
    assert not any(dest.iterdir())


def test_missing_file_is_reported_as_unavailable(server, dest):
    with pytest.raises(DownloadError) as exc:
        download(f"{server}/nope.mp4", dest, max_bytes=MB)
    assert exc.value.code == "unavailable"


@pytest.mark.parametrize(
    "url",
    [
        "https://www.instagram.com/reel/C1abcDEFgh/",
        "https://www.instagram.com/p/C1abcDEFgh/?img_index=1",
        "https://vm.tiktok.com/ZMabc123/",
        "https://www.tiktok.com/@user/video/7300000000000000000",
        "https://youtu.be/dQw4w9WgXcQ",
        "https://www.youtube.com/shorts/dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
        "https://x.com/user/status/1234567890",
        "https://www.aparat.com/v/abc12",
    ],
)
def test_video_links(url):
    assert is_video_link(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://www.google.com/search?q=x",
        "https://github.com/foo/bar",
        "https://t.me/somechannel/123",
        "https://www.instagram.com/someone/",
        "https://www.tiktok.com/@user",
        "https://www.youtube.com/@somechannel",
        "https://www.youtube.com/playlist?list=PL123",
        "https://soundcloud.com/a/sets/b",
    ],
)
def test_not_video_links(url):
    assert not is_video_link(url)
