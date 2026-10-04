"""A product's pictures and videos for sellers to download: the marketplace listing's,
the 1688 offer's and its page's, fetched through our server (those hosts are often
unreachable from Iran), plus store-ready square copies and one ZIP of everything."""

from __future__ import annotations

import io
import re
import zipfile
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

# Hosts we fetch from for sellers, and nothing else.
IMAGE_HOSTS = ("alicdn.com", "1688.com", "media-amazon.com", "ssl-images-amazon.com", "kwcdn.com")
VIDEO_HOSTS = (*IMAGE_HOSTS, "taobao.com", "tbcdn.cn")
MAX_IMAGE = 8_000_000  # bytes
MAX_VIDEO = 150_000_000
MAX_IMAGES = 24  # per product
MAX_VIDEOS = 6
READY_SIZE = 1200  # px, the square store picture

SOURCE_FA = {"temu": "Temu", "amazon": "آمازون", "1688": "1688"}


def allowed(url: str, hosts: tuple[str, ...]) -> bool:
    """An https link on one of ``hosts`` (or a subdomain), on the standard port, with nothing
    a parser could read differently from the HTTP client that fetches it: no user@ part, no
    backslash, no spaces or control characters. Anything else might reach another server
    (SSRF), so it's refused."""
    url = url or ""
    if len(url) > 2048 or "\\" in url or any(ord(ch) <= 32 or ord(ch) == 127 for ch in url):
        return False
    try:
        parts = urlsplit(url)
        port = parts.port
        fetched = httpx.URL(url)
    except (ValueError, httpx.InvalidURL):
        return False
    host = (parts.hostname or "").lower()
    if (
        parts.scheme != "https"
        or not host.isascii()
        or "@" in parts.netloc
        or port not in (None, 443)
        or fetched.raw_host.decode("ascii", "replace").lower() != host  # where it connects
        or fetched.userinfo
    ):
        return False
    return any(host == h or host.endswith("." + h) for h in hosts)


def fetch(client: httpx.Client, url: str, limit: int) -> tuple[int, str, bytes] | None:
    """GETs a picture without ever holding more than ``limit`` bytes of it: (status,
    content type, body), or None when it failed or was too big."""
    try:
        with client.stream("GET", url) as r:
            if int(r.headers.get("content-length") or 0) > limit:
                return None
            body = bytearray()
            for chunk in r.iter_bytes(65536):
                body += chunk
                if len(body) > limit:
                    return None
            return r.status_code, r.headers.get("content-type", ""), bytes(body)
    except (httpx.HTTPError, ValueError):
        return None


def collect(candidate: dict[str, Any], detail: dict[str, Any] | None) -> dict[str, list[dict]]:
    """Every picture and video of a product, deduplicated, each with where it's from:
    the 1688 page first (the supplier's own, usually the best), then the listing's."""
    images: list[dict] = []
    videos: list[dict] = []
    seen: set[str] = set()

    def add(into: list[dict], url: str, source: str, hosts: tuple[str, ...]) -> None:
        url = (url or "").strip()
        if url.startswith("//"):
            url = "https:" + url
        if url and url not in seen and allowed(url, hosts):
            seen.add(url)
            into.append({"url": url, "source": source})

    for url in (detail or {}).get("images", []):
        add(images, url, "1688", IMAGE_HOSTS)
    for url in (detail or {}).get("videos", []):
        add(videos, url, "1688", VIDEO_HOSTS)
    add(images, (candidate.get("offer") or {}).get("image_url", ""), "1688", IMAGE_HOSTS)
    for listing in [candidate.get("listing") or {}, *(candidate.get("matches") or [])]:
        add(images, listing.get("image_url", ""), listing.get("source", ""), IMAGE_HOSTS)
    return {"images": images[:MAX_IMAGES], "videos": videos[:MAX_VIDEOS]}


def file_name(title: str, n: int, ext: str) -> str:
    """A download name from the product's title: Persian letters kept, the rest dashed."""
    base = re.sub(r"[^\w؀-ۿ]+", "-", title or "").strip("-")[:60] or "product"
    return f"{base}-{n:02d}.{ext}"


def disposition(name: str) -> str:
    """Content-Disposition for a download whose name may be Persian (RFC 6266/5987)."""
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "download"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


def extension(content_type: str, url: str) -> str:
    kind = content_type.split(";")[0].strip().lower()
    known = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
             "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov"}  # fmt: skip
    if kind in known:
        return known[kind]
    tail = urlsplit(url).path.rsplit(".", 1)
    return tail[1].lower()[:4] if len(tail) == 2 and tail[1].isalnum() else "bin"


def store_ready(data: bytes, size: int = READY_SIZE) -> bytes:
    """The picture centred on a white square (what most stores ask for), as a JPEG."""
    from PIL import Image, ImageOps  # only needed here

    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            flat = Image.new("RGB", im.size, "white")
            flat.paste(im, mask=im.getchannel("A"))
            im = flat
        else:
            im = im.convert("RGB")
        im.thumbnail((size, size), Image.LANCZOS)
        square = Image.new("RGB", (size, size), "white")
        square.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
        out = io.BytesIO()
        square.save(out, "JPEG", quality=90, optimize=True)
        return out.getvalue()


def zip_images(title: str, pictures: list[tuple[bytes, str]]) -> bytes:
    """One ZIP: each picture as it came, and its store-ready square copy."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n, (data, ext) in enumerate(pictures, 1):
            z.writestr(f"original/{file_name(title, n, ext)}", data)
            try:
                z.writestr(
                    f"store-ready-{READY_SIZE}/{file_name(title, n, 'jpg')}", store_ready(data)
                )
            except Exception:  # a picture Pillow can't read stays as it came
                pass
    return buf.getvalue()
