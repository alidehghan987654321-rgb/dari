"""Download media from (almost) any URL with yt-dlp.

This module is deliberately independent from Telegram so it can be tested and
reused on its own. :func:`download` is blocking; run it in a worker thread from
async code.
"""

from __future__ import annotations

import functools
import logging
import re
import shutil
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import yt_dlp
import yt_dlp.extractor
from yt_dlp.utils import DownloadError as YtDlpDownloadError

log = logging.getLogger(__name__)

# Formats Telegram clients can play inline. Anything else is sent as a file.
VIDEO_EXTS = {".mp4", ".m4v", ".mov"}
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav"}
PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

# If the best version is too big for Telegram, try again at these heights.
FALLBACK_HEIGHTS = (480, 360, 240)

# Extractors for a whole channel/profile/playlist rather than a single post,
# e.g. "youtube:tab", "tiktok:user", "instagram:user".
_COLLECTION_IE = re.compile(
    r":.*(tab|playlist|channel|user|profile|search|feed|collection|album|series|season|\bsets?\b|\bshows?\b)"
)


class DownloadError(Exception):
    """Raised when nothing could be downloaded.

    ``code`` says why, for the UI to explain in the user's language:
    unsupported, login, private, unavailable, no_video, failed, too_large
    (with ``limit_mb``).
    """

    def __init__(self, code: str, **details: Any) -> None:
        super().__init__(code)
        self.code = code
        self.details = details


@dataclass
class MediaFile:
    path: Path
    kind: str  # "video" | "audio" | "photo" | "document"
    title: str = ""
    uploader: str = ""
    webpage_url: str = ""  # the post/page the media came from
    width: int | None = None
    height: int | None = None
    duration: int | None = None

    @property
    def size(self) -> int:
        return self.path.stat().st_size


@dataclass(frozen=True)
class Progress:
    downloaded: int  # bytes
    total: int | None  # bytes, None while unknown
    speed: float | None  # bytes per second

    @property
    def fraction(self) -> float | None:
        if not self.total:
            return None
        return min(self.downloaded / self.total, 1.0)


@dataclass
class DownloadResult:
    files: list[MediaFile] = field(default_factory=list)
    too_large: int = 0  # items dropped for exceeding the size limit


def kind_for(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in PHOTO_EXTS:
        return "photo"
    return "document"


@functools.cache
def _site_extractors() -> tuple[type, ...]:
    return tuple(ie for ie in yt_dlp.extractor.gen_extractor_classes() if ie.ie_key() != "Generic")


def is_video_link(url: str) -> bool:
    """Whether ``url`` looks like a single video/post on a site yt-dlp knows.

    Used in groups and channels, where people post all sorts of links: this
    skips ordinary web pages, Telegram links and whole channels or profiles
    (which would flood the chat with videos). It only matches URL patterns,
    so it's fast and offline. The first call takes ~0.5 s to compile them.
    """
    ie = next((ie for ie in _site_extractors() if ie.suitable(url)), None)
    if ie is None or ie.IE_NAME.lower().startswith("telegram"):
        return False
    if _COLLECTION_IE.search(ie.IE_NAME.lower()):
        # youtube.com/watch?v=...&list=... is one video that happens to be in a playlist.
        return "v" in parse_qs(urlsplit(url).query)
    return True


def _as_int(value: Any) -> int | None:
    try:
        return round(float(value))
    except (TypeError, ValueError):
        return None


def _iter_entries(info: dict[str, Any] | None) -> Iterator[dict[str, Any]]:
    """Yield every downloaded video entry, flattening (nested) playlists."""
    if not info:
        return
    if info.get("_type") == "playlist" or "entries" in info:
        for entry in info.get("entries") or []:
            yield from _iter_entries(entry)
    else:
        yield info


def _build_options(
    dest: Path,
    *,
    max_bytes: int,
    max_height: int,
    max_items: int,
    cookies_file: str | None,
    proxy: str | None,
) -> dict[str, Any]:
    has_ffmpeg = shutil.which("ffmpeg") is not None
    opts: dict[str, Any] = {
        # Without ffmpeg separate video/audio streams can't be merged, so only
        # pick formats that already contain both.
        "format": "bv*+ba/b" if has_ffmpeg else "b",
        # Prefer <= max_height, H.264/AAC in MP4: plays everywhere in Telegram
        # and keeps files small enough for the upload limit.
        "format_sort": [f"res:{max_height}", "vcodec:h264", "acodec:aac", "ext:mp4:m4a"],
        "merge_output_format": "mp4",
        "outtmpl": str(dest / "%(playlist_index|0)s_%(id).60B.%(ext)s"),
        "restrictfilenames": True,
        "noplaylist": True,  # a YouTube video inside a playlist -> just that video
        "playlistend": max_items,  # but carousels (e.g. Instagram) are allowed
        "max_filesize": max_bytes,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "concurrent_fragment_downloads": 4,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "logger": log,
    }
    if cookies_file:
        opts["cookiefile"] = cookies_file
    if proxy:
        opts["proxy"] = proxy
    return opts


def _collect(info: dict[str, Any] | None, max_bytes: int) -> DownloadResult:
    result = DownloadResult()
    seen: set[Path] = set()
    for entry in _iter_entries(info):
        for item in entry.get("requested_downloads") or []:
            filepath = item.get("filepath")
            if not filepath:
                # yt-dlp aborted it for exceeding max_filesize.
                result.too_large += 1
                continue
            path = Path(filepath)
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            if path.stat().st_size > max_bytes:
                result.too_large += 1
                path.unlink(missing_ok=True)
                continue
            result.files.append(
                MediaFile(
                    path=path,
                    kind=kind_for(path),
                    title=entry.get("title") or "",
                    uploader=entry.get("uploader") or entry.get("channel") or "",
                    webpage_url=entry.get("webpage_url") or "",
                    width=_as_int(item.get("width") or entry.get("width")),
                    height=_as_int(item.get("height") or entry.get("height")),
                    duration=_as_int(entry.get("duration")),
                )
            )
    return result


def _progress_hook(callback: Callable[[Progress], None]) -> Callable[[dict[str, Any]], None]:
    """Turn yt-dlp's per-file progress into overall progress.

    A video can be several files (e.g. separate video and audio streams, or
    the items of a carousel), so sizes are summed across all of them.
    """
    files: dict[str, tuple[int, int | None]] = {}

    def hook(d: dict[str, Any]) -> None:
        if d.get("status") not in ("downloading", "finished"):
            return
        done = d.get("downloaded_bytes") or 0
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        if d["status"] == "finished":
            done = total = total or done
        files[d.get("filename") or ""] = (done, total)
        totals = [t for _, t in files.values()]
        callback(
            Progress(
                downloaded=sum(dn for dn, _ in files.values()),
                total=int(sum(totals)) if all(totals) else None,
                speed=d.get("speed"),
            )
        )

    return hook


def _error_code(message: str) -> str:
    """Sort a yt-dlp error message into one of DownloadError's codes."""
    text = message.lower()
    if "unsupported url" in text:
        return "unsupported"
    if any(k in text for k in ("login", "cookies", "sign in", "rate-limit", "rate limit")):
        return "login"
    if "private" in text:
        return "private"
    if any(k in text for k in ("not available", "unavailable", "removed", "404")):
        return "unavailable"
    if "no video" in text:
        return "no_video"
    return "failed"


def download(
    url: str,
    dest: Path,
    *,
    max_bytes: int,
    max_height: int = 720,
    max_items: int = 10,
    cookies_file: str | None = None,
    proxy: str | None = None,
    progress: Callable[[Progress], None] | None = None,
) -> DownloadResult:
    """Download the media behind ``url`` into ``dest``.

    Files larger than ``max_bytes`` are dropped; if that leaves nothing, the
    download is retried at lower resolutions. Raises :class:`DownloadError`
    when nothing could be downloaded.
    ``progress`` is called (from this thread) as the download advances.
    """
    heights = [max_height] + [h for h in FALLBACK_HEIGHTS if h < max_height]
    while heights:
        height = heights.pop(0)
        opts = _build_options(
            dest,
            max_bytes=max_bytes,
            max_height=height,
            max_items=max_items,
            cookies_file=cookies_file,
            proxy=proxy,
        )
        if progress:
            opts["progress_hooks"] = [_progress_hook(progress)]
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
        except YtDlpDownloadError as exc:
            log.warning("yt-dlp failed for %s: %s", url, exc)
            raise DownloadError(_error_code(str(exc))) from exc

        entries = list(_iter_entries(info))
        if not entries:
            raise DownloadError("no_video")

        result = _collect(info, max_bytes)
        if result.files:
            return result

        # Nothing was kept: yt-dlp skips or aborts files over max_filesize and
        # _collect drops any that still came out too big. Retry only at
        # heights below what was picked, otherwise the same format comes back.
        picked = max((_as_int(e.get("height")) or 0 for e in entries), default=0)
        heights = [h for h in heights if h < picked]
        if heights:
            log.info("%s too large at %sp, retrying at %sp", url, height, heights[0])
        for leftover in dest.iterdir():
            if leftover.is_file():
                leftover.unlink(missing_ok=True)

    raise DownloadError("too_large", limit_mb=max_bytes // (1024 * 1024))
