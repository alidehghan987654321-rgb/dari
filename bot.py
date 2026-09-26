"""Telegram bot that downloads videos from Instagram, TikTok, YouTube, X, ...

Send it a link and it replies with the video. All the site-specific work is
done by yt-dlp (see downloader.py), so any site yt-dlp supports works here.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from telegram import Message, MessageEntity, Update
from telegram.constants import ChatAction
from telegram.error import TelegramError
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from downloader import DownloadError, MediaFile, download

log = logging.getLogger("bot")

MAX_URLS_PER_MESSAGE = 5
CAPTION_LIMIT = 1024

START_TEXT = (
    "سلام! 👋\n\n"
    "لینک ویدیو را برایم بفرستید تا دانلودش کنم و برایتان بفرستم.\n\n"
    "سایت‌های پشتیبانی‌شده: اینستاگرام، تیک‌تاک، یوتیوب، توییتر (X)، فیسبوک، "
    "ردیت، پینترست، ساندکلاد، آپارات و صدها سایت دیگر.\n\n"
    "می‌توانید چند لینک را هم در یک پیام بفرستید."
)


@dataclass(frozen=True)
class Config:
    token: str
    allowed_users: frozenset[int]
    max_bytes: int
    max_height: int
    max_items: int
    max_concurrent: int
    cookies_file: str | None
    proxy: str | None
    bot_api_url: str | None
    bot_api_file_url: str | None

    @classmethod
    def from_env(cls) -> Config:
        token = os.getenv("BOT_TOKEN", "").strip()
        if not token:
            raise SystemExit("BOT_TOKEN is not set. Copy .env.example to .env and fill it in.")
        allowed = frozenset(
            int(x) for x in os.getenv("ALLOWED_USERS", "").replace(" ", "").split(",") if x
        )
        cookies = os.getenv("COOKIES_FILE") or None
        if cookies and not Path(cookies).is_file():
            raise SystemExit(f"COOKIES_FILE {cookies!r} does not exist.")
        return cls(
            token=token,
            allowed_users=allowed,
            max_bytes=int(float(os.getenv("MAX_FILE_SIZE_MB", "49")) * 1024 * 1024),
            max_height=int(os.getenv("VIDEO_MAX_HEIGHT", "720")),
            max_items=int(os.getenv("MAX_ITEMS_PER_LINK", "10")),
            max_concurrent=int(os.getenv("MAX_CONCURRENT_DOWNLOADS", "3")),
            cookies_file=cookies,
            proxy=os.getenv("PROXY") or None,
            bot_api_url=os.getenv("BOT_API_URL") or None,
            bot_api_file_url=os.getenv("BOT_API_FILE_URL") or None,
        )


def extract_urls(message: Message) -> list[str]:
    """Return the unique links in a message (text or caption), in order."""
    types = [MessageEntity.URL, MessageEntity.TEXT_LINK]
    found = {**message.parse_entities(types), **message.parse_caption_entities(types)}
    urls: list[str] = []
    for entity, text in found.items():
        url = entity.url if entity.type == MessageEntity.TEXT_LINK else text
        if not url:
            continue
        if "://" not in url:
            url = "https://" + url
        if url.split("://", 1)[0].lower() not in ("http", "https"):
            continue
        if url not in urls:
            urls.append(url)
    return urls


def make_caption(media: MediaFile) -> str | None:
    title = media.title.strip()
    if not title:
        return None
    if len(title) > CAPTION_LIMIT:
        title = title[: CAPTION_LIMIT - 1] + "…"
    return title


@contextlib.asynccontextmanager
async def chat_action(message: Message, action: str):
    """Keep showing "sending video..." until the block exits (Telegram clears it after 5s)."""

    async def loop() -> None:
        while True:
            with contextlib.suppress(TelegramError):
                await message.chat.send_action(action)
            await asyncio.sleep(4)

    task = asyncio.create_task(loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def send_media(message: Message, media: MediaFile) -> None:
    caption = make_caption(media)
    if media.kind == "video":
        await message.reply_video(
            video=media.path,
            caption=caption,
            width=media.width,
            height=media.height,
            duration=media.duration,
            supports_streaming=True,
        )
    elif media.kind == "audio":
        await message.reply_audio(audio=media.path, caption=caption, duration=media.duration)
    elif media.kind == "photo":
        try:
            await message.reply_photo(photo=media.path, caption=caption)
        except TelegramError:
            # Telegram rejects photos with odd dimensions or > 10 MB.
            await message.reply_document(document=media.path, caption=caption)
    else:
        await message.reply_document(document=media.path, caption=caption)


async def process_url(message: Message, url: str, config: Config, sem: asyncio.Semaphore) -> None:
    status = await message.reply_text("⏳ در صف دانلود...")
    try:
        async with sem:
            await status.edit_text("⏳ در حال دانلود...")
            with tempfile.TemporaryDirectory(prefix="dl_") as tmp:
                async with chat_action(message, ChatAction.UPLOAD_VIDEO):
                    result = await asyncio.to_thread(
                        download,
                        url,
                        Path(tmp),
                        max_bytes=config.max_bytes,
                        max_height=config.max_height,
                        max_items=config.max_items,
                        cookies_file=config.cookies_file,
                        proxy=config.proxy,
                    )
                    await status.edit_text("📤 در حال ارسال...")
                    for media in result.files:
                        await send_media(message, media)
        if result.too_large:
            await status.edit_text(
                f"✅ ارسال شد. {result.too_large} فایل به دلیل حجم زیاد ارسال نشد."
            )
        else:
            await status.delete()
    except DownloadError as exc:
        await status.edit_text(f"❌ {exc}")
    except TelegramError as exc:
        log.exception("Sending %s failed", url)
        await status.edit_text(f"❌ ارسال فایل به تلگرام ناموفق بود: {exc.message}")
    except Exception:
        log.exception("Unexpected error for %s", url)
        await status.edit_text("❌ خطای غیرمنتظره رخ داد. دوباره امتحان کنید.")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.effective_message.reply_text(START_TEXT)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    config: Config = context.bot_data["config"]
    sem: asyncio.Semaphore = context.bot_data["semaphore"]

    urls = extract_urls(message)
    if not urls:
        if message.chat.type == "private":
            await message.reply_text("لطفاً لینک ویدیو را بفرستید. 🔗")
        return
    if len(urls) > MAX_URLS_PER_MESSAGE:
        await message.reply_text(f"فقط {MAX_URLS_PER_MESSAGE} لینک اول دانلود می‌شود.")
        urls = urls[:MAX_URLS_PER_MESSAGE]

    log.info("User %s requested %s", getattr(update.effective_user, "id", None), urls)
    await asyncio.gather(*(process_url(message, url, config, sem) for url in urls))


async def reject(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat.type == "private":
        await update.effective_message.reply_text("⛔️ شما اجازه استفاده از این ربات را ندارید.")


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    log.error("Unhandled error while processing %s", update, exc_info=context.error)


def build_app(config: Config) -> Application:
    builder = (
        ApplicationBuilder()
        .token(config.token)
        .concurrent_updates(True)
        .read_timeout(60)
        .write_timeout(60)
        .media_write_timeout(600)
    )
    if config.proxy:
        builder = builder.proxy(config.proxy).get_updates_proxy(config.proxy)
    if config.bot_api_url:
        builder = builder.base_url(config.bot_api_url)
        if config.bot_api_file_url:
            builder = builder.base_file_url(config.bot_api_file_url)
    app = builder.build()

    app.bot_data["config"] = config
    app.bot_data["semaphore"] = asyncio.Semaphore(config.max_concurrent)

    if config.allowed_users:
        allowed = filters.User(user_id=config.allowed_users)
        app.add_handler(MessageHandler(~allowed, reject))
    app.add_handler(CommandHandler(["start", "help"], start))
    links = (filters.TEXT | filters.CAPTION) & ~filters.COMMAND & filters.UpdateType.MESSAGE
    app.add_handler(MessageHandler(links, handle_message))
    app.add_error_handler(on_error)
    return app


def main() -> None:
    load_dotenv()
    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
    )
    # httpx logs every getUpdates poll at INFO.
    logging.getLogger("httpx").setLevel(logging.WARNING)

    config = Config.from_env()
    app = build_app(config)
    log.info("Bot is running. Press Ctrl+C to stop.")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
