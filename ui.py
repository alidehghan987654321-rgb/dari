"""Everything users see: texts, captions, buttons and the progress bar.

The bot speaks English and Persian: each user gets the language their
Telegram app is set to (Persian for "fa", English otherwise) and can switch
with a button. Every function takes that language as its first argument.

Messages use Telegram's HTML formatting, so anything that comes from outside
(titles, uploader names, chat titles) goes through ``escape``.
"""

from __future__ import annotations

from html import escape
from typing import Any

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

from downloader import DownloadError, MediaFile, Progress

LANGS = ("en", "fa")
TITLE_LIMIT = 300  # captions are capped at 1024 characters
BAR_WIDTH = 12

# callback_data of the buttons under the welcome message
CB_HELP = "help"
CB_HOME = "home"
CB_LANG = "lang:"  # + language code

_FA_DIGITS = str.maketrans("0123456789.", "۰۱۲۳۴۵۶۷۸۹٫")

_SITES = {
    "en": "Instagram, TikTok, YouTube, X (Twitter), Facebook, Reddit, Pinterest, SoundCloud, Aparat",
    "fa": "اینستاگرام، تیک‌تاک، یوتیوب، توییتر (X)، فیسبوک، ردیت، پینترست، ساندکلاد، آپارات",
}

TEXTS: dict[str, dict[str, str]] = {
    "en": {
        # bot profile (shown before /start and when the bot is shared)
        "short_description": (
            "📥 Download videos from Instagram, TikTok, YouTube, X and 1000+ sites — "
            "in chats, groups and channels"
        ),
        "description": (
            "🎬 Any video, with just a link!\n\n"
            "🔗 Send me a video link and I'll send you the video.\n"
            "🌐 Instagram, TikTok, YouTube, X, Facebook, Aparat and 1000+ more sites\n"
            "👥 Works in groups and channels too.\n\n"
            "Tap START to begin 👇"
        ),
        "cmd_start": "🏠 Start & help",
        "cmd_dl": "⬇️ Download a video from a link",
        "cmd_lang": "🌐 فارسی / English",
        "lang_switched": "🌐 I'll talk to you in English now.",
        # welcome & help
        "welcome": (
            "<b>Hi! 👋 Welcome to Video Downloader.</b>\n\n"
            "🔗 Send me a video link and I'll send you the video right here.\n\n"
            "🌐 <b>Sites:</b> {sites} and 1000+ more\n\n"
            "👥 I also work in <b>groups</b> and <b>channels</b> — add me with the buttons below."
        ),
        "help": (
            "📖 <b>Help</b>\n\n"
            "👤 <b>Private chat</b>\n"
            "Send a link — several links in one message work too.\n\n"
            "👥 <b>Groups</b>\n"
            "Add me and I'll reply to every video link with the video itself. "
            "<code>/dl</code> + a link, or <code>/dl</code> as a reply to a message, works too.\n\n"
            "📢 <b>Channels</b>\n"
            "Make me an admin (“Post messages” is all I need) and I'll post the video under "
            "the post.\n\n"
            "📦 Max file size: <b>{max_mb} MB</b>"
        ),
        "btn_add_group": "➕ Add to group",
        "btn_add_channel": "📢 Add to channel",
        "btn_help": "📖 Help",
        "btn_back": "🔙 Back",
        "btn_web": "🌐 Website",
        "btn_other_lang": "🇮🇷 فارسی",
        "btn_source": "🔗 View original post",
        "group_help": (
            "<b>Hi! 👋 I'm a video downloader bot.</b>\n\n"
            "🎬 Whenever someone posts a video link here, I'll reply with the video.\n"
            "⌨️ Or type <code>/dl</code> and a link, or reply <code>/dl</code> to a message "
            "with a link.\n"
            "💡 If a video doesn't show up, try <code>/dl</code> and I'll tell you why.\n\n"
            "🌐 {sites} and 1000+ more"
        ),
        "group_admin_hint": (
            "\n\n⚠️ <b>Right now I only see /dl.</b> To download every link automatically, "
            "make me a group admin (no special rights needed)."
        ),
        "channel_added": (
            "✅ <b>I've been added to “{title}”.</b>\n"
            "From now on, whenever you post a video link there, I'll post the video under it."
        ),
        "channel_no_post": (
            "\n\n⚠️ But I don't have the <b>Post messages</b> right. "
            "Give it to me in the channel's admin settings."
        ),
        "no_link": (
            "🔗 Please send a <b>video link</b>.\n"
            "For example: <code>https://www.instagram.com/reel/...</code>"
        ),
        "dl_usage": (
            "⌨️ Put the link after the command:\n"
            "<code>/dl https://www.instagram.com/reel/...</code>\n\n"
            "or reply <code>/dl</code> to a message that has a link."
        ),
        "not_allowed": "⛔️ You're not allowed to use this bot.",
        "too_many_links": "⚠️ Only the first {n} links will be downloaded.",
        # progress
        "queued": "⏳ <b>Waiting in line...</b>\nOther downloads are running; hang on a moment.",
        "checking": "🔎 <b>Checking the link...</b>",
        "downloading": "⬇️ <b>Downloading...</b>",
        "sending": "📤 <b>Sending to Telegram...</b>",
        "of": "of",
        "per_second": "/s",
        "mb": "MB",
        "kb": "KB",
        "percent": "{n}%",
        # results
        "failed": "❌ <b>Download failed</b>\n{reason}",
        "send_failed": "❌ <b>Couldn't send it to Telegram</b>\n{reason}",
        "unexpected": "❌ <b>Something went wrong</b>\nPlease try again.",
        "partly_sent": "✅ Sent.\n⚠️ {n} file(s) were too large to send.",
        # DownloadError codes
        "err_unsupported": "This link isn't supported.",
        "err_login": (
            "This site needs a login to download, or it's limiting requests right now. "
            "The bot's admin can set a cookies file (COOKIES_FILE)."
        ),
        "err_private": "This content is private and can't be downloaded.",
        "err_unavailable": "This content isn't available or has been removed.",
        "err_no_video": "No video found at this link.",
        "err_failed": "The download failed. Check the link and try again.",
        "err_too_large": "The file is bigger than the {limit_mb} MB limit.",
    },
    "fa": {
        "short_description": (
            "📥 دانلود ویدیو از اینستاگرام، تیک‌تاک، یوتیوب، توییتر و صدها سایت دیگر؛ "
            "در چت، گروه و کانال"
        ),
        "description": (
            "🎬 هر ویدیویی، فقط با یک لینک!\n\n"
            "🔗 لینک ویدیو را بفرستید تا خود ویدیو را برایتان بفرستم.\n"
            "🌐 اینستاگرام، تیک‌تاک، یوتیوب، توییتر، فیسبوک، آپارات و بیش از ۱۰۰۰ سایت دیگر\n"
            "👥 در گروه‌ها و کانال‌ها هم کار می‌کنم.\n\n"
            "برای شروع، دکمه‌ی START را بزنید 👇"
        ),
        "cmd_start": "🏠 شروع و راهنما",
        "cmd_dl": "⬇️ دانلود ویدیو از لینک",
        "cmd_lang": "🌐 English / فارسی",
        "lang_switched": "🌐 از این به بعد فارسی صحبت می‌کنم.",
        "welcome": (
            "<b>سلام! 👋 به ربات دانلود ویدیو خوش آمدید.</b>\n\n"
            "🔗 لینک ویدیو را بفرستید؛ خود ویدیو را همین‌جا تحویل بگیرید.\n\n"
            "🌐 <b>سایت‌ها:</b> {sites} و بیش از ۱۰۰۰ سایت دیگر\n\n"
            "👥 در <b>گروه‌ها</b> و <b>کانال‌ها</b> هم کار می‌کنم؛ با دکمه‌های زیر اضافه‌ام کنید."
        ),
        "help": (
            "📖 <b>راهنما</b>\n\n"
            "👤 <b>چت خصوصی</b>\n"
            "لینک را بفرستید؛ چند لینک در یک پیام هم می‌شود.\n\n"
            "👥 <b>گروه</b>\n"
            "اضافه‌ام کنید؛ زیر هر لینک ویدیو، خود ویدیو را می‌فرستم. "
            "با <code>/dl</code> و لینک، یا ریپلای <code>/dl</code> روی پیام هم کار می‌کنم.\n\n"
            "📢 <b>کانال</b>\n"
            "ادمینم کنید (دسترسی «ارسال پیام» کافی است)؛ ویدیو را زیر همان پست می‌گذارم.\n\n"
            "📦 حداکثر حجم هر فایل: <b>{max_mb} مگابایت</b>"
        ),
        "btn_add_group": "➕ افزودن به گروه",
        "btn_add_channel": "📢 افزودن به کانال",
        "btn_help": "📖 راهنما",
        "btn_back": "🔙 بازگشت",
        "btn_web": "🌐 نسخه‌ی وب",
        "btn_other_lang": "🇬🇧 English",
        "btn_source": "🔗 مشاهده‌ی پست اصلی",
        "group_help": (
            "<b>سلام! 👋 من ربات دانلود ویدیو هستم.</b>\n\n"
            "🎬 هر لینک ویدیویی که در گروه فرستاده شود، ویدیویش را زیرش می‌فرستم.\n"
            "⌨️ یا بنویسید <code>/dl</code> و بعد لینک، یا روی پیامی که لینک دارد "
            "<code>/dl</code> را ریپلای کنید.\n"
            "💡 اگر ویدیویی نیامد، با <code>/dl</code> امتحان کنید تا دلیلش را بگویم.\n\n"
            "🌐 {sites} و بیش از ۱۰۰۰ سایت دیگر"
        ),
        "group_admin_hint": (
            "\n\n⚠️ <b>الان فقط دستور /dl را می‌بینم.</b> برای دانلود خودکار همه‌ی لینک‌ها، "
            "من را ادمین گروه کنید (هیچ دسترسی خاصی لازم نیست)."
        ),
        "channel_added": (
            "✅ <b>به کانال «{title}» اضافه شدم.</b>\n"
            "از این به بعد هر لینک ویدیویی که در کانال بگذارید، ویدیویش را زیر همان پست می‌فرستم."
        ),
        "channel_no_post": (
            "\n\n⚠️ ولی اجازه‌ی <b>«ارسال پیام» (Post Messages)</b> ندارم. "
            "در تنظیمات ادمین‌های کانال این دسترسی را به من بدهید."
        ),
        "no_link": (
            "🔗 لطفاً <b>لینک</b> ویدیو را بفرستید.\n"
            "مثلاً: <code>https://www.instagram.com/reel/...</code>"
        ),
        "dl_usage": (
            "⌨️ لینک را بعد از دستور بنویسید:\n"
            "<code>/dl https://www.instagram.com/reel/...</code>\n\n"
            "یا روی پیامی که لینک دارد <code>/dl</code> را ریپلای کنید."
        ),
        "not_allowed": "⛔️ شما اجازه‌ی استفاده از این ربات را ندارید.",
        "too_many_links": "⚠️ فقط {n} لینک اول دانلود می‌شود.",
        "queued": "⏳ <b>در صف دانلود...</b>\nچند دانلود دیگر در جریان است؛ کمی صبر کنید.",
        "checking": "🔎 <b>در حال بررسی لینک...</b>",
        "downloading": "⬇️ <b>در حال دانلود...</b>",
        "sending": "📤 <b>در حال ارسال به تلگرام...</b>",
        "of": "از",
        "per_second": "/ثانیه",
        "mb": "مگابایت",
        "kb": "کیلوبایت",
        "percent": "{n}٪",
        "failed": "❌ <b>دانلود نشد</b>\n{reason}",
        "send_failed": "❌ <b>ارسال به تلگرام ناموفق بود</b>\n{reason}",
        "unexpected": "❌ <b>خطای غیرمنتظره</b>\nدوباره امتحان کنید.",
        "partly_sent": "✅ ارسال شد.\n⚠️ {n} فایل به دلیل حجم زیاد ارسال نشد.",
        "err_unsupported": "این لینک پشتیبانی نمی‌شود.",
        "err_login": (
            "این سایت برای دانلود نیاز به ورود (لاگین) دارد یا موقتاً محدودیت گذاشته است. "
            "مدیر ربات می‌تواند فایل کوکی (COOKIES_FILE) را تنظیم کند."
        ),
        "err_private": "این محتوا خصوصی است و قابل دانلود نیست.",
        "err_unavailable": "این محتوا در دسترس نیست یا حذف شده است.",
        "err_no_video": "در این لینک ویدیویی پیدا نشد.",
        "err_failed": "دانلود ناموفق بود. لینک را بررسی کنید و دوباره امتحان کنید.",
        "err_too_large": "حجم فایل بیشتر از حد مجاز ({limit_mb} مگابایت) است.",
    },
}


def pick_lang(language_code: str | None, default: str = "en") -> str:
    """Persian for Persian Telegram apps, English for everything else."""
    if not language_code:
        return default
    return "fa" if language_code.lower().startswith("fa") else "en"


def other_lang(lang: str) -> str:
    return "en" if lang == "fa" else "fa"


def num(lang: str, value: object) -> str:
    """Write a number in the language's digits."""
    text = str(value)
    return text.translate(_FA_DIGITS) if lang == "fa" else text


def t(lang: str, key: str, **values: Any) -> str:
    """A text in ``lang``; numbers passed in are written in its digits."""
    values = {k: num(lang, v) if isinstance(v, int) else v for k, v in values.items()}
    return TEXTS[lang][key].format(sites=_SITES[lang], **values)


# ------------------------------------------------------------ welcome & help


def welcome(lang: str) -> str:
    return t(lang, "welcome")


def help_text(lang: str, max_mb: int) -> str:
    return t(lang, "help", max_mb=max_mb)


def welcome_keyboard(
    lang: str, bot_username: str, site_url: str | None = None
) -> InlineKeyboardMarkup:
    link = f"https://t.me/{bot_username}"
    second_row = [InlineKeyboardButton(t(lang, "btn_help"), callback_data=CB_HELP)]
    if site_url:
        second_row.append(InlineKeyboardButton(t(lang, "btn_web"), url=site_url))
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton(t(lang, "btn_add_group"), url=f"{link}?startgroup=add"),
                InlineKeyboardButton(
                    t(lang, "btn_add_channel"),
                    url=f"{link}?startchannel=add&admin=post_messages",
                ),
            ],
            second_row,
            [
                InlineKeyboardButton(
                    t(lang, "btn_other_lang"), callback_data=CB_LANG + other_lang(lang)
                )
            ],
        ]
    )


def help_keyboard(lang: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton(t(lang, "btn_back"), callback_data=CB_HOME)]]
    )


def group_help(lang: str, sees_all_messages: bool) -> str:
    text = t(lang, "group_help")
    if not sees_all_messages:
        text += t(lang, "group_admin_hint")
    return text


def channel_added(lang: str, title: str, can_post: bool) -> str:
    text = t(lang, "channel_added", title=escape(title))
    if not can_post:
        text += t(lang, "channel_no_post")
    return text


def too_many_links(lang: str, limit: int) -> str:
    return t(lang, "too_many_links", n=limit)


# ------------------------------------------------------------------ progress


def format_size(lang: str, num_bytes: float) -> str:
    mb = num_bytes / (1024 * 1024)
    if mb >= 1:
        return f"{num(lang, f'{mb:.1f}')} {t(lang, 'mb')}"
    return f"{num(lang, round(num_bytes / 1024))} {t(lang, 'kb')}"


def format_duration(seconds: int) -> str:
    minutes, sec = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02}:{sec:02}"
    return f"{minutes}:{sec:02}"


def progress_bar(fraction: float, width: int = BAR_WIDTH) -> str:
    filled = round(max(0.0, min(fraction, 1.0)) * width)
    return f"<code>{'█' * filled}{'░' * (width - filled)}</code>"


def downloading(lang: str, progress: Progress) -> str:
    lines = [t(lang, "downloading")]
    if progress.fraction is not None:
        percent = t(lang, "percent", n=round(progress.fraction * 100))
        lines.append(f"{progress_bar(progress.fraction)}  {percent}")
        size = (
            f"{format_size(lang, progress.downloaded)} {t(lang, 'of')} "
            f"{format_size(lang, progress.total)}"
        )
    else:
        size = format_size(lang, progress.downloaded)
    if progress.speed:
        size += f"  •  {format_size(lang, progress.speed)}{t(lang, 'per_second')}"
    lines.append(size)
    return "\n".join(lines)


def error_reason(lang: str, error: DownloadError) -> str:
    return t(lang, f"err_{error.code}", **error.details)


def failed(lang: str, error: DownloadError) -> str:
    return t(lang, "failed", reason=escape(error_reason(lang, error)))


def send_failed(lang: str, reason: str) -> str:
    return t(lang, "send_failed", reason=escape(reason))


def partly_sent(lang: str, too_large: int) -> str:
    return t(lang, "partly_sent", n=too_large)


# ------------------------------------------------------------------- results


def media_caption(lang: str, media: MediaFile, bot_username: str | None = None) -> str | None:
    """Title, uploader and duration, plus a "@bot" signature if given."""
    lines = []
    title = " ".join(media.title.split())
    if title:
        if len(title) > TITLE_LIMIT:
            title = title[: TITLE_LIMIT - 1] + "…"
        lines.append(f"🎬 <b>{escape(title)}</b>")
    meta = []
    if media.uploader:
        meta.append(f"👤 {escape(media.uploader)}")
    if media.duration:
        meta.append(f"⏱ {num(lang, format_duration(media.duration))}")
    if meta:
        lines.append("  •  ".join(meta))
    if bot_username:
        lines.append(("\n" if lines else "") + f"📥 @{bot_username}")
    return "\n".join(lines) or None


def source_keyboard(lang: str, media: MediaFile) -> InlineKeyboardMarkup | None:
    if not media.webpage_url.startswith(("http://", "https://")):
        return None
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton(t(lang, "btn_source"), url=media.webpage_url)]]
    )
