"""Telegram bot that downloads videos from Instagram, TikTok, YouTube, X, ...

Send it a link and it replies with the video. It also works in groups and
channels: add it and it replies to every video link posted there. All the
site-specific work is done by yt-dlp (see downloader.py), so any site yt-dlp
supports works here.
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
from telegram import (
    Bot,
    BotCommand,
    Chat,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    MessageEntity,
    Update,
)
from telegram.constants import ChatAction, ChatMemberStatus, ChatType
from telegram.error import RetryAfter, TelegramError
from telegram.ext import (
    Application,
    ApplicationBuilder,
    ChatMemberHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from downloader import DownloadError, MediaFile, download, is_video_link

# Opt in to PTB's upcoming behaviour (durations as timedelta), which also
# silences its deprecation warning when reading RetryAfter.retry_after.
os.environ.setdefault("PTB_TIMEDELTA", "1")

log = logging.getLogger("bot")

MAX_URLS_PER_MESSAGE = 5
CAPTION_LIMIT = 1024
SEND_ATTEMPTS = 3
GROUP_TYPES = (ChatType.GROUP, ChatType.SUPERGROUP)

SITES = "اینستاگرام، تیک‌تاک، یوتیوب، توییتر (X)، فیسبوک، ردیت، پینترست، ساندکلاد، آپارات و صدها سایت دیگر"
START_TEXT = (
    "سلام! 👋\n\n"
    "لینک ویدیو را برایم بفرستید تا دانلودش کنم و برایتان بفرستم.\n\n"
    f"سایت‌های پشتیبانی‌شده: {SITES}.\n\n"
    "می‌توانید چند لینک را هم در یک پیام بفرستید.\n\n"
    "👥 در گروه‌ها و کانال‌ها هم کار می‌کنم؛ با دکمه‌های زیر من را اضافه کنید."
)
DL_USAGE = "لینک را بعد از دستور بنویسید، مثلاً:\n/dl https://www.instagram.com/reel/...\nیا روی پیامی که لینک دارد /dl را ریپلای کنید."


def group_help(sees_all_messages: bool) -> str:
    text = (
        "سلام! 👋 من ویدیوی لینک‌ها را دانلود می‌کنم و همین‌جا می‌فرستم.\n"
        f"({SITES})\n\n"
        "• هر لینک ویدیویی که در گروه فرستاده شود، ویدیویش را زیرش می‌فرستم.\n"
        "• یا بنویسید /dl و بعد لینک، یا روی پیامی که لینک دارد /dl را ریپلای کنید.\n"
        "• اگر ویدیویی نیامد، با /dl امتحان کنید تا دلیلش را بگویم."
    )
    if not sees_all_messages:
        text += (
            "\n\n⚠️ الان فقط دستور /dl را می‌بینم. برای دانلود خودکار همه‌ی لینک‌ها، "
            "من را ادمین گروه کنید (هیچ دسترسی خاصی لازم نیست)."
        )
    return text


def add_to_chat_keyboard(bot_username: str) -> InlineKeyboardMarkup:
    link = f"https://t.me/{bot_username}"
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("➕ افزودن به گروه", url=f"{link}?startgroup=add")],
            [
                InlineKeyboardButton(
                    "📢 افزودن به کانال", url=f"{link}?startchannel=add&admin=post_messages"
                )
            ],
        ]
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
    """Reply with ``media``, waiting out Telegram's flood limits (busy groups hit them)."""
    for attempt in range(1, SEND_ATTEMPTS + 1):
        try:
            await _send_media(message, media)
            return
        except RetryAfter as exc:
            if attempt == SEND_ATTEMPTS:
                raise
            delay = exc.retry_after.total_seconds() + 1
            log.warning("Flood limit in chat %s, retrying in %.0fs", message.chat.id, delay)
            await asyncio.sleep(delay)


async def _send_media(message: Message, media: MediaFile) -> None:
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


async def process_url(
    message: Message,
    url: str,
    config: Config,
    sem: asyncio.Semaphore,
    *,
    verbose: bool = True,
) -> None:
    """Download ``url`` and reply to ``message`` with the media.

    ``verbose`` shows progress and errors in the chat. It's off for links the
    bot picks up by itself in groups and channels, where it should only speak
    up with a video (and where every channel post notifies all subscribers).
    """
    status: Message | None = None

    async def show(text: str) -> None:
        nonlocal status
        if not verbose:
            return
        if status is None:
            status = await message.reply_text(text)
        else:
            await status.edit_text(text)

    try:
        if sem.locked():
            await show("⏳ در صف دانلود...")
        async with sem:
            await show("⏳ در حال دانلود...")
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
                    await show("📤 در حال ارسال...")
                    for media in result.files:
                        await send_media(message, media)
        if result.too_large:
            await show(f"✅ ارسال شد. {result.too_large} فایل به دلیل حجم زیاد ارسال نشد.")
        elif status is not None:
            await status.delete()
    except DownloadError as exc:
        log.info("Could not download %s: %s", url, exc)
        await show(f"❌ {exc}")
    except TelegramError as exc:
        log.exception("Sending %s failed", url)
        await show(f"❌ ارسال فایل به تلگرام ناموفق بود: {exc.message}")
    except Exception:
        log.exception("Unexpected error for %s", url)
        await show("❌ خطای غیرمنتظره رخ داد. دوباره امتحان کنید.")


async def download_and_send(
    message: Message, urls: list[str], context: ContextTypes.DEFAULT_TYPE, *, verbose: bool
) -> None:
    config: Config = context.bot_data["config"]
    sem: asyncio.Semaphore = context.bot_data["semaphore"]
    if len(urls) > MAX_URLS_PER_MESSAGE:
        if verbose:
            await message.reply_text(f"فقط {MAX_URLS_PER_MESSAGE} لینک اول دانلود می‌شود.")
        urls = urls[:MAX_URLS_PER_MESSAGE]
    user_id = message.from_user.id if message.from_user else None
    log.info("Chat %s, user %s requested %s", message.chat.id, user_id, urls)
    await asyncio.gather(*(process_url(message, url, config, sem, verbose=verbose) for url in urls))


async def sees_all_messages(chat: Chat, bot: Bot) -> bool:
    """Whether the bot receives every message in a group, not just commands."""
    if bot.can_read_all_group_messages:  # privacy mode is off
        return True
    member = await chat.get_member(bot.id)
    return member.status == ChatMemberStatus.ADMINISTRATOR


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if message.chat.type == ChatType.PRIVATE:
        await message.reply_text(
            START_TEXT, reply_markup=add_to_chat_keyboard(context.bot.username)
        )
    elif context.args:
        # "/start add" is sent when someone adds the bot with the button from
        # START_TEXT; on_my_chat_member has already said hello.
        return
    else:
        await message.reply_text(group_help(await sees_all_messages(message.chat, context.bot)))


async def dl_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/dl <link>, or /dl as a reply to a message with links."""
    message = update.effective_message
    urls = extract_urls(message)
    if message.reply_to_message:
        urls += [u for u in extract_urls(message.reply_to_message) if u not in urls]
    if not urls:
        await message.reply_text(DL_USAGE)
        return
    await download_and_send(message, urls, context, verbose=True)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    private = message.chat.type == ChatType.PRIVATE
    urls = extract_urls(message)
    if not private:
        # People post all sorts of links in groups and channels; only react to videos.
        urls = [url for url in urls if is_video_link(url)]
    if not urls:
        if private:
            await message.reply_text("لطفاً لینک ویدیو را بفرستید. 🔗")
        return
    await download_and_send(message, urls, context, verbose=private)


async def on_my_chat_member(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Say hello when added to a group; tell whoever added it to a channel that it's set up."""
    change = update.my_chat_member
    chat, old, new = change.chat, change.old_chat_member, change.new_chat_member
    was_in = old.status not in (ChatMemberStatus.LEFT, ChatMemberStatus.BANNED)

    if (
        chat.type in GROUP_TYPES
        and not was_in
        and new.status
        in (
            ChatMemberStatus.MEMBER,
            ChatMemberStatus.ADMINISTRATOR,
        )
    ):
        log.info("Added to group %s (%s)", chat.id, chat.title)
        sees_all = (
            context.bot.can_read_all_group_messages or new.status == ChatMemberStatus.ADMINISTRATOR
        )
        with contextlib.suppress(TelegramError):
            await chat.send_message(group_help(sees_all))

    elif (
        chat.type == ChatType.CHANNEL
        and new.status == ChatMemberStatus.ADMINISTRATOR
        and old.status != ChatMemberStatus.ADMINISTRATOR
    ):
        log.info("Added to channel %s (%s)", chat.id, chat.title)
        text = (
            f"✅ به کانال «{chat.title}» اضافه شدم.\n"
            "از این به بعد هر لینک ویدیویی که در کانال بگذارید، ویدیویش را زیر همان پست می‌فرستم."
        )
        if not getattr(new, "can_post_messages", False):
            text += (
                "\n\n⚠️ ولی اجازه‌ی «ارسال پیام» (Post Messages) ندارم. "
                "در تنظیمات ادمین‌های کانال این دسترسی را به من بدهید."
            )
        # Only works if that person has started a chat with the bot before.
        with contextlib.suppress(TelegramError):
            await context.bot.send_message(change.from_user.id, text)


async def reject(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat.type == "private":
        await update.effective_message.reply_text("⛔️ شما اجازه استفاده از این ربات را ندارید.")


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    log.error("Unhandled error while processing %s", update, exc_info=context.error)


async def post_init(app: Application) -> None:
    await app.bot.set_my_commands(
        [BotCommand("start", "راهنما"), BotCommand("dl", "دانلود ویدیو از لینک")]
    )
    if not app.bot.can_join_groups:
        log.warning("Adding the bot to groups is disabled. Enable it: @BotFather -> /setjoingroups")
    if not app.bot.can_read_all_group_messages:
        log.warning(
            "Privacy mode is on, so in groups where the bot isn't admin it only sees /dl. "
            "To download every link: @BotFather -> /setprivacy -> Disable, then re-add the bot."
        )
    # Compile yt-dlp's URL patterns now rather than on the first group message.
    await asyncio.to_thread(is_video_link, "https://example.com")


def build_app(config: Config) -> Application:
    builder = (
        ApplicationBuilder()
        .token(config.token)
        .concurrent_updates(True)
        .read_timeout(60)
        .write_timeout(60)
        .media_write_timeout(600)
        .post_init(post_init)
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
        # IDs may be users (anywhere) or groups/channels (everyone in them).
        ids = config.allowed_users
        allowed = filters.User(user_id=ids) | filters.Chat(chat_id=ids)
        app.add_handler(MessageHandler(~allowed, reject))
    new_message = filters.UpdateType.MESSAGE  # not edits, which would download again
    app.add_handler(CommandHandler(["start", "help"], start, filters=new_message))
    app.add_handler(CommandHandler("dl", dl_command, filters=new_message))
    links = (
        (filters.TEXT | filters.CAPTION)
        & ~filters.COMMAND
        & (filters.UpdateType.MESSAGE | filters.UpdateType.CHANNEL_POST)
        # A channel post copied into the channel's discussion group: the bot
        # already answered it in the channel.
        & ~filters.IS_AUTOMATIC_FORWARD
    )
    app.add_handler(MessageHandler(links, handle_message))
    app.add_handler(ChatMemberHandler(on_my_chat_member, ChatMemberHandler.MY_CHAT_MEMBER))
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
