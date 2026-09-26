"""Website version of the downloader: paste a link, get the video.

Runs next to the Telegram bot (see docker-compose.yml) and uses the same
downloader. Jobs live in memory and their files are deleted after a while.
Errors are sent as codes; the page (static/i18n.js) words them in English or
Persian.

    uvicorn web:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import secrets
import shutil
import tempfile
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from telegram import Bot
from telegram.error import TelegramError
from telegram.request import HTTPXRequest

from downloader import DownloadError, MediaFile, Progress, download, is_video_link

log = logging.getLogger("web")

ROOT = Path(__file__).resolve().parent
MAX_JOBS_PER_IP = 2  # running or queued at once
MAX_QUEUE = 30  # across everyone
CLEANUP_EVERY = 60  # seconds


@dataclass(frozen=True)
class Settings:
    max_bytes: int
    max_height: int
    max_items: int
    max_concurrent: int
    file_ttl: int  # seconds a finished job's files stay downloadable
    cookies_file: str | None
    proxy: str | None
    bot_token: str | None

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            max_bytes=int(float(os.getenv("WEB_MAX_FILE_SIZE_MB", "300")) * 1024 * 1024),
            max_height=int(os.getenv("WEB_VIDEO_MAX_HEIGHT", "1080")),
            max_items=int(os.getenv("MAX_ITEMS_PER_LINK", "10")),
            max_concurrent=int(os.getenv("MAX_CONCURRENT_DOWNLOADS", "3")),
            file_ttl=int(os.getenv("WEB_FILE_TTL_MINUTES", "30")) * 60,
            cookies_file=os.getenv("COOKIES_FILE") or None,
            proxy=os.getenv("PROXY") or None,
            bot_token=os.getenv("BOT_TOKEN", "").strip() or None,
        )


@dataclass
class Job:
    id: str
    url: str
    ip: str
    dir: Path
    status: str = "queued"  # queued | downloading | done | error
    progress: Progress | None = None
    files: list[MediaFile] = field(default_factory=list)
    too_large: int = 0
    error: str | None = None  # a DownloadError code, or "unexpected"
    error_details: dict[str, Any] = field(default_factory=dict)
    finished_at: float | None = None

    @property
    def active(self) -> bool:
        return self.status in ("queued", "downloading")

    def to_json(self) -> dict[str, Any]:
        progress = None
        if self.progress:
            p = self.progress
            progress = {
                "downloaded": p.downloaded,
                "total": p.total,
                "speed": p.speed,
                "fraction": p.fraction,
            }
        return {
            "id": self.id,
            "status": self.status,
            "progress": progress,
            "error": self.error,
            "error_details": self.error_details,
            "too_large": self.too_large,
            "files": [
                {
                    "url": f"/files/{self.id}/{i}",
                    "kind": m.kind,
                    "size": m.size,
                    "title": m.title,
                    "uploader": m.uploader,
                    "duration": m.duration,
                    "width": m.width,
                    "height": m.height,
                    "source": m.webpage_url,
                }
                for i, m in enumerate(self.files)
            ],
        }


class JobRequest(BaseModel):
    url: str = Field(max_length=2048)


def normalize_url(text: str) -> str:
    url = text.strip()
    if url and "://" not in url:
        url = "https://" + url
    return url


def download_name(media: MediaFile, index: int) -> str:
    """A readable file name from the title, e.g. "Sunset at the beach.mp4"."""
    title = re.sub(r"[^\w\s\-]", "", media.title, flags=re.UNICODE)
    title = " ".join(title.split())[:60].strip()
    return f"{title or f'video-{index + 1}'}{media.path.suffix}"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    jobs: dict[str, Job] = {}
    running: set[asyncio.Task[None]] = set()  # keeps the tasks from being garbage collected
    sem = asyncio.Semaphore(settings.max_concurrent)
    info: dict[str, Any] = {
        "bot_username": None,
        "max_mb": settings.max_bytes // (1024 * 1024),
    }
    workdir = Path(tempfile.mkdtemp(prefix="web_"))

    async def find_bot_username() -> None:
        """For the "open in Telegram" buttons; the site works without it."""
        if not settings.bot_token:
            return
        request = HTTPXRequest(proxy=settings.proxy) if settings.proxy else None
        try:
            async with Bot(settings.bot_token, request=request) as bot:
                info["bot_username"] = bot.username
        except TelegramError as exc:
            log.warning("Could not look up the Telegram bot: %s", exc)

    def sweep(now: float) -> None:
        for job in list(jobs.values()):
            if job.finished_at is not None and now - job.finished_at > settings.file_ttl:
                shutil.rmtree(job.dir, ignore_errors=True)
                del jobs[job.id]

    async def cleanup_loop() -> None:
        while True:
            await asyncio.sleep(CLEANUP_EVERY)
            sweep(time.monotonic())

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await find_bot_username()
        cleaner = asyncio.create_task(cleanup_loop())
        try:
            yield
        finally:
            cleaner.cancel()
            shutil.rmtree(workdir, ignore_errors=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.jobs = jobs
    app.state.sweep = sweep

    async def run(job: Job) -> None:
        async with sem:
            job.status = "downloading"

            def on_progress(progress: Progress) -> None:  # runs in the download thread
                job.progress = progress

            try:
                result = await asyncio.to_thread(
                    download,
                    job.url,
                    job.dir,
                    max_bytes=settings.max_bytes,
                    max_height=settings.max_height,
                    max_items=settings.max_items,
                    cookies_file=settings.cookies_file,
                    proxy=settings.proxy,
                    progress=on_progress,
                )
            except DownloadError as exc:
                job.error, job.error_details = exc.code, exc.details
                job.status = "error"
            except Exception:
                log.exception("Unexpected error for %s", job.url)
                job.error = "unexpected"
                job.status = "error"
            else:
                job.files, job.too_large = result.files, result.too_large
                job.status = "done"
            finally:
                job.finished_at = time.monotonic()

    @app.get("/api/info")
    async def get_info() -> dict[str, Any]:
        return info

    @app.post("/api/jobs", status_code=202)
    async def create_job(body: JobRequest, request: Request) -> dict[str, Any]:
        url = normalize_url(body.url)
        if not url.lower().startswith(("http://", "https://")):
            raise HTTPException(400, "bad_link")
        # Only links to known sites: this is a public page, and a generic
        # "fetch any URL" service invites abuse.
        if not is_video_link(url):
            raise HTTPException(400, "unsupported_link")
        ip = request.client.host if request.client else "?"
        active = [j for j in jobs.values() if j.active]
        if sum(j.ip == ip for j in active) >= MAX_JOBS_PER_IP:
            raise HTTPException(429, "too_many_jobs")
        if len(active) >= MAX_QUEUE:
            raise HTTPException(503, "busy")

        job_id = secrets.token_urlsafe(12)
        job = Job(id=job_id, url=url, ip=ip, dir=workdir / job_id)
        job.dir.mkdir()
        jobs[job_id] = job
        log.info("Job %s from %s: %s", job_id, ip, url)
        task = asyncio.create_task(run(job))
        running.add(task)
        task.add_done_callback(running.discard)
        return job.to_json()

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str) -> dict[str, Any]:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "not_found")
        return job.to_json()

    @app.get("/files/{job_id}/{index}")
    async def get_file(job_id: str, index: int, inline: bool = False) -> FileResponse:
        job = jobs.get(job_id)
        if job is None or not 0 <= index < len(job.files) or not job.files[index].path.is_file():
            raise HTTPException(404, "not_found")
        media = job.files[index]
        return FileResponse(
            media.path,
            filename=download_name(media, index),
            content_disposition_type="inline" if inline else "attachment",
        )

    app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")
    app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")
    return app


def _configure_logging() -> None:
    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)


load_dotenv()
_configure_logging()
app = create_app()
