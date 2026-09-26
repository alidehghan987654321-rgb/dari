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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from telegram import (
    Bot,
    BotCommand,
    Chat,
    InputProfilePhotoStatic,
    Message,
    MessageEntity,
    Update,
)
from telegram.constants import ChatAction, ChatMemberStatus, ChatType, ParseMode
from telegram.error import BadRequest, RetryAfter, TelegramError
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CallbackQueryHandler,
    ChatMemberHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

import ui
from downloader import DownloadError, MediaFile, Progress, download, is_video_link

# Opt in to PTB's upcoming behaviour (durations as timedelta), which also
# silences its deprecation warning when reading RetryAfter.retry_after.
os.environ.setdefault("PTB_TIMEDELTA", "1")

log = logging.getLogger("bot")

MAX_URLS_PER_MESSAGE = 5
SEND_ATTEMPTS = 3
PROGRESS_INTERVAL = 3  # seconds between progress bar updates
GROUP_PROGRESS_INTERVAL = 6  # groups allow ~20 messages a minute, edits included
GROUP_TYPES = (ChatType.GROUP, ChatType.SUPERGROUP)
HTML = ParseMode.HTML

ASSETS = Path(__file__).resolve().parent / "assets"
BANNER = ASSETS / "banner.png"
AVATAR = ASSETS / "avatar.png"


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
    site_url: str | None = None  # the website, if it's set up (web.py)

    @classmethod
    def from_env(cls) -> Config:
        token = os.getenv("BOT_TOKEN", "").strip()
        if not token:
            raise SystemExit("BOT_TOKEN is not set. Copy .env.example to .env and fill it in.")
        allowed = frozenset(
            int(x) for x in os.getenv("ALLOWED_USERS", "").replace(" ", "").split(",") if x
        )
        domain = os.getenv("DOMAIN", "").strip()
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
            site_url=f"https://{domain}" if domain and domain != "localhost" else None,
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


@contextlib.asynccontextmanager
async def every(seconds: float, action: Callable[[], Awaitable[object]]):
    """Run ``action`` now and then every ``seconds`` until the block exits."""

    async def loop() -> None:
        while True:
            with contextlib.suppress(TelegramError):
                await action()
            await asyncio.sleep(seconds)

    task = asyncio.create_task(loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


class StatusMessage:
    """The message the bot keeps editing to show what it's doing with a link.

    Does nothing unless ``verbose``: for links the bot picks up by itself in
    groups and channels it should only speak up with a video (and in channels
    every message notifies all subscribers).
    """

    def __init__(self, reply_to: Message, verbose: bool) -> None:
        self._reply_to = reply_to
        self._verbose = verbose
        self._message: Message | None = None
        self._text = ""

    async def show(self, text: str) -> None:
        if not self._verbose or text == self._text:
            return
        if self._message is None:
            self._message = await self._reply_to.reply_text(text, parse_mode=HTML)
        else:
            await self._message.edit_text(text, parse_mode=HTML)
        self._text = text

    async def delete(self) -> None:
        if self._message is not None:
            await self._message.delete()


async def send_media(message: Message, media: MediaFile, signature: str | None = None) -> None:
    """Reply with ``media``, waiting out Telegram's flood limits (busy groups hit them)."""
    for attempt in range(1, SEND_ATTEMPTS + 1):
        try:
            await _send_media(message, media, signature)
            return
        except RetryAfter as exc:
            if attempt == SEND_ATTEMPTS:
                raise
            delay = exc.retry_after.total_seconds() + 1
            log.warning("Flood limit in chat %s, retrying in %.0fs", message.chat.id, delay)
            await asyncio.sleep(delay)


async def _send_media(message: Message, media: MediaFile, signature: str | None) -> None:
    extra = {
        "caption": ui.media_caption(media, signature),
        "parse_mode": HTML,
        "reply_markup": ui.source_keyboard(media),
    }
    if media.kind == "video":
        await message.reply_video(
            video=media.path,
            width=media.width,
            height=media.height,
            duration=media.duration,
            supports_streaming=True,
            **extra,
        )
    elif media.kind == "audio":
        await message.reply_audio(audio=media.path, duration=media.duration, **extra)
    elif media.kind == "photo":
        try:
            await message.reply_photo(photo=media.path, **extra)
        except RetryAfter:
            raise
        except TelegramError:
            # Telegram rejects photos with odd dimensions or > 10 MB.
            await message.reply_document(document=media.path, **extra)
    else:
        await message.reply_document(document=media.path, **extra)


async def process_url(
    message: Message,
    url: str,
    config: Config,
    sem: asyncio.Semaphore,
    *,
    verbose: bool = True,
) -> None:
    """Download ``url`` and reply to ``message`` with the media.

    ``verbose`` shows progress and errors in the chat (see StatusMessage).
    """
    status = StatusMessage(message, verbose)
    latest: Progress | None = None

    def on_progress(progress: Progress) -> None:  # runs in the download thread
        nonlocal latest
        latest = progress

    async def show_progress() -> None:
        if latest is not None:
            await status.show(ui.downloading(latest))

    private = message.chat.type == ChatType.PRIVATE
    interval = PROGRESS_INTERVAL if private else GROUP_PROGRESS_INTERVAL
    progress_updates = every(interval, show_progress) if verbose else contextlib.nullcontext()
    # "@bot" under the video, except in channels, which are someone else's brand.
    signature = None if message.chat.type == ChatType.CHANNEL else message.get_bot().username

    try:
        if sem.locked():
            await status.show(ui.QUEUED)
        async with sem:
            await status.show(ui.CHECKING)
            with tempfile.TemporaryDirectory(prefix="dl_") as tmp:
                async with every(4, lambda: message.chat.send_action(ChatAction.UPLOAD_VIDEO)):
                    async with progress_updates:
                        result = await asyncio.to_thread(
                            download,
                            url,
                            Path(tmp),
                            max_bytes=config.max_bytes,
                            max_height=config.max_height,
                            max_items=config.max_items,
                            cookies_file=config.cookies_file,
                            proxy=config.proxy,
                            progress=on_progress,
                        )
                    await status.show(ui.SENDING)
                    for media in result.files:
                        await send_media(message, media, signature)
        if result.too_large:
            await status.show(ui.partly_sent(result.too_large))
        else:
            await status.delete()
    except DownloadError as exc:
        log.info("Could not download %s: %s", url, exc)
        await status.show(ui.failed(str(exc)))
    except TelegramError as exc:
        log.exception("Sending %s failed", url)
        await status.show(ui.send_failed(exc.message))
    except Exception:
        log.exception("Unexpected error for %s", url)
        await status.show(ui.UNEXPECTED)


async def download_and_send(
    message: Message, urls: list[str], context: ContextTypes.DEFAULT_TYPE, *, verbose: bool
) -> None:
    config: Config = context.bot_data["config"]
    sem: asyncio.Semaphore = context.bot_data["semaphore"]
    if len(urls) > MAX_URLS_PER_MESSAGE:
        if verbose:
            await message.reply_text(ui.too_many_links(MAX_URLS_PER_MESSAGE), parse_mode=HTML)
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
        await send_welcome(message, context)
    elif context.args:
        # "/start add" is sent when someone adds the bot with the button under
        # the welcome message; on_my_chat_member has already said hello.
        return
    else:
        sees_all = await sees_all_messages(message.chat, context.bot)
        await message.reply_text(ui.group_help(sees_all), parse_mode=HTML)


async def send_welcome(message: Message, context: ContextTypes.DEFAULT_TYPE) -> None:
    keyboard = ui.welcome_keyboard(context.bot.username, context.bot_data["config"].site_url)
    # Upload the banner once, then reuse Telegram's copy.
    banner = context.bot_data.get("banner_file_id") or (BANNER if BANNER.is_file() else None)
    if banner is None:
        await message.reply_text(ui.WELCOME, parse_mode=HTML, reply_markup=keyboard)
        return
    sent = await message.reply_photo(
        banner, caption=ui.WELCOME, parse_mode=HTML, reply_markup=keyboard
    )
    if sent.photo:
        context.bot_data["banner_file_id"] = sent.photo[-1].file_id


async def on_menu_button(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """The "help" / "back" buttons under the welcome message."""
    query = update.callback_query
    await query.answer()
    if query.data == ui.CB_HELP:
        max_mb = context.bot_data["config"].max_bytes // (1024 * 1024)
        text, keyboard = ui.help_text(max_mb), ui.help_keyboard()
    else:
        site_url = context.bot_data["config"].site_url
        text, keyboard = ui.WELCOME, ui.welcome_keyboard(context.bot.username, site_url)
    # Double taps would try to "edit" to the same text.
    with contextlib.suppress(BadRequest):
        if getattr(query.message, "photo", None):
            await query.edit_message_caption(caption=text, parse_mode=HTML, reply_markup=keyboard)
        else:
            await query.edit_message_text(text, parse_mode=HTML, reply_markup=keyboard)


async def dl_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/dl <link>, or /dl as a reply to a message with links."""
    message = update.effective_message
    urls = extract_urls(message)
    if message.reply_to_message:
        urls += [u for u in extract_urls(message.reply_to_message) if u not in urls]
    if not urls:
        await message.reply_text(ui.DL_USAGE, parse_mode=HTML)
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
            await message.reply_text(ui.NO_LINK, parse_mode=HTML)
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
            await chat.send_message(ui.group_help(sees_all), parse_mode=HTML)

    elif (
        chat.type == ChatType.CHANNEL
        and new.status == ChatMemberStatus.ADMINISTRATOR
        and old.status != ChatMemberStatus.ADMINISTRATOR
    ):
        log.info("Added to channel %s (%s)", chat.id, chat.title)
        text = ui.channel_added(chat.title or "", getattr(new, "can_post_messages", False))
        # Only works if that person has started a chat with the bot before.
        with contextlib.suppress(TelegramError):
            await context.bot.send_message(change.from_user.id, text, parse_mode=HTML)


async def reject(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat.type == "private":
        await update.effective_message.reply_text(ui.NOT_ALLOWED)


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    log.error("Unhandled error while processing %s", update, exc_info=context.error)


async def setup_profile(bot: Bot) -> None:
    """Give the bot a description and profile picture, unless it already has them.

    Whatever the owner sets in @BotFather is left alone.
    """
    try:
        if not (await bot.get_my_short_description()).short_description:
            await bot.set_my_short_description(ui.SHORT_DESCRIPTION)
        if not (await bot.get_my_description()).description:
            await bot.set_my_description(ui.DESCRIPTION)
        photos = await bot.get_user_profile_photos(bot.id, limit=1)
        if photos.total_count == 0 and AVATAR.is_file():
            await bot.set_my_profile_photo(InputProfilePhotoStatic(AVATAR.read_bytes()))
            log.info("Set the bot's profile picture")
    except TelegramError as exc:
        log.warning("Could not set up the bot's profile: %s", exc)


async def post_init(app: Application) -> None:
    await app.bot.set_my_commands([BotCommand(cmd, text) for cmd, text in ui.COMMANDS.items()])
    await setup_profile(app.bot)
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
    menu = f"^({ui.CB_HELP}|{ui.CB_HOME})$"
    app.add_handler(CallbackQueryHandler(on_menu_button, pattern=menu))
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
