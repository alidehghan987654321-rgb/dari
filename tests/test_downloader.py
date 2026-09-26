from pathlib import Path

import pytest
from conftest import MB

from downloader import DownloadError, download, kind_for


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
    result = download(f"{server}/small.mp4", dest, max_bytes=MB)
    assert len(result.files) == 1
    media = result.files[0]
    assert media.kind == "video"
    assert media.path.parent == dest
    assert media.size == 200_000
    assert result.too_large == 0


def test_rejects_file_over_limit(server, dest):
    with pytest.raises(DownloadError, match="1 مگابایت"):
        download(f"{server}/big.mp4", dest, max_bytes=MB)
    assert not any(dest.iterdir())


def test_missing_file_is_friendly_error(server, dest):
    with pytest.raises(DownloadError) as exc:
        download(f"{server}/nope.mp4", dest, max_bytes=MB)
    assert "404" not in str(exc.value)
