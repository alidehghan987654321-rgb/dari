"""Everything users see: texts, captions, buttons and the progress bar.

Messages use Telegram's HTML formatting, so anything that comes from outside
(titles, uploader names, chat titles, error text) goes through ``escape``.
"""

from __future__ import annotations

from html import escape

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

from downloader import MediaFile, Progress

_FA_DIGITS = str.maketrans("0123456789.", "۰۱۲۳۴۵۶۷۸۹٫")

TITLE_LIMIT = 300  # captions are capped at 1024 characters
BAR_WIDTH = 12

# callback_data of the menu buttons under the welcome message
CB_HELP = "help"
CB_HOME = "home"

SITES = "اینستاگرام، تیک‌تاک، یوتیوب، توییتر (X)، فیسبوک، ردیت، پینترست، ساندکلاد، آپارات"


def fa(value: object) -> str:
    """Write numbers with Persian digits."""
    return str(value).translate(_FA_DIGITS)


# ---------------------------------------------------------------- bot profile

SHORT_DESCRIPTION = (
    "📥 دانلود ویدیو از اینستاگرام، تیک‌تاک، یوتیوب، توییتر و صدها سایت دیگر؛ در چت، گروه و کانال"
)
DESCRIPTION = (
    "🎬 هر ویدیویی، فقط با یک لینک!\n\n"
    "🔗 لینک ویدیو را بفرستید تا خود ویدیو را برایتان بفرستم.\n"
    "🌐 اینستاگرام، تیک‌تاک، یوتیوب، توییتر، فیسبوک، آپارات و بیش از ۱۰۰۰ سایت دیگر\n"
    "👥 در گروه‌ها و کانال‌ها هم کار می‌کنم.\n\n"
    "برای شروع، دکمه‌ی START را بزنید 👇"
)
COMMANDS = {"start": "🏠 شروع و راهنما", "dl": "⬇️ دانلود ویدیو از لینک"}


# ------------------------------------------------------------ welcome & help

WELCOME = (
    "<b>سلام! 👋 به ربات دانلود ویدیو خوش آمدید.</b>\n\n"
    "🔗 لینک ویدیو را بفرستید؛ خود ویدیو را همین‌جا تحویل بگیرید.\n\n"
    f"🌐 <b>سایت‌ها:</b> {SITES} و بیش از ۱۰۰۰ سایت دیگر\n\n"
    "👥 در <b>گروه‌ها</b> و <b>کانال‌ها</b> هم کار می‌کنم؛ با دکمه‌های زیر اضافه‌ام کنید."
)


def help_text(max_mb: int) -> str:
    return (
        "📖 <b>راهنما</b>\n\n"
        "👤 <b>چت خصوصی</b>\n"
        "لینک را بفرستید؛ چند لینک در یک پیام هم می‌شود.\n\n"
        "👥 <b>گروه</b>\n"
        "اضافه‌ام کنید؛ زیر هر لینک ویدیو، خود ویدیو را می‌فرستم. "
        "با <code>/dl</code> و لینک، یا ریپلای <code>/dl</code> روی پیام هم کار می‌کنم.\n\n"
        "📢 <b>کانال</b>\n"
        "ادمینم کنید (دسترسی «ارسال پیام» کافی است)؛ ویدیو را زیر همان پست می‌گذارم.\n\n"
        f"📦 حداکثر حجم هر فایل: <b>{fa(max_mb)} مگابایت</b>"
    )


def welcome_keyboard(bot_username: str) -> InlineKeyboardMarkup:
    link = f"https://t.me/{bot_username}"
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("➕ افزودن به گروه", url=f"{link}?startgroup=add"),
                InlineKeyboardButton(
                    "📢 افزودن به کانال", url=f"{link}?startchannel=add&admin=post_messages"
                ),
            ],
            [InlineKeyboardButton("📖 راهنما", callback_data=CB_HELP)],
        ]
    )


def help_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("🔙 بازگشت", callback_data=CB_HOME)]])


def group_help(sees_all_messages: bool) -> str:
    text = (
        "<b>سلام! 👋 من ربات دانلود ویدیو هستم.</b>\n\n"
        "🎬 هر لینک ویدیویی که در گروه فرستاده شود، ویدیویش را زیرش می‌فرستم.\n"
        "⌨️ یا بنویسید <code>/dl</code> و بعد لینک، یا روی پیامی که لینک دارد "
        "<code>/dl</code> را ریپلای کنید.\n"
        "💡 اگر ویدیویی نیامد، با <code>/dl</code> امتحان کنید تا دلیلش را بگویم.\n\n"
        f"🌐 {SITES} و بیش از ۱۰۰۰ سایت دیگر"
    )
    if not sees_all_messages:
        text += (
            "\n\n⚠️ <b>الان فقط دستور /dl را می‌بینم.</b> برای دانلود خودکار همه‌ی لینک‌ها، "
            "من را ادمین گروه کنید (هیچ دسترسی خاصی لازم نیست)."
        )
    return text


def channel_added(title: str, can_post: bool) -> str:
    text = (
        f"✅ <b>به کانال «{escape(title)}» اضافه شدم.</b>\n"
        "از این به بعد هر لینک ویدیویی که در کانال بگذارید، ویدیویش را زیر همان پست می‌فرستم."
    )
    if not can_post:
        text += (
            "\n\n⚠️ ولی اجازه‌ی <b>«ارسال پیام» (Post Messages)</b> ندارم. "
            "در تنظیمات ادمین‌های کانال این دسترسی را به من بدهید."
        )
    return text


NO_LINK = (
    "🔗 لطفاً <b>لینک</b> ویدیو را بفرستید.\nمثلاً: <code>https://www.instagram.com/reel/...</code>"
)
DL_USAGE = (
    "⌨️ لینک را بعد از دستور بنویسید:\n"
    "<code>/dl https://www.instagram.com/reel/...</code>\n\n"
    "یا روی پیامی که لینک دارد <code>/dl</code> را ریپلای کنید."
)
NOT_ALLOWED = "⛔️ شما اجازه‌ی استفاده از این ربات را ندارید."


def too_many_links(limit: int) -> str:
    return f"⚠️ فقط {fa(limit)} لینک اول دانلود می‌شود."


# ------------------------------------------------------------------ progress


def format_size(num_bytes: float) -> str:
    mb = num_bytes / (1024 * 1024)
    if mb >= 1:
        return f"{fa(f'{mb:.1f}')} مگابایت"
    return f"{fa(round(num_bytes / 1024))} کیلوبایت"


def format_duration(seconds: int) -> str:
    minutes, sec = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02}:{sec:02}"
    return f"{minutes}:{sec:02}"


def progress_bar(fraction: float, width: int = BAR_WIDTH) -> str:
    filled = round(max(0.0, min(fraction, 1.0)) * width)
    return f"<code>{'█' * filled}{'░' * (width - filled)}</code>"


QUEUED = "⏳ <b>در صف دانلود...</b>\nچند دانلود دیگر در جریان است؛ کمی صبر کنید."
CHECKING = "🔎 <b>در حال بررسی لینک...</b>"
SENDING = "📤 <b>در حال ارسال به تلگرام...</b>"
UNEXPECTED = "❌ <b>خطای غیرمنتظره</b>\nدوباره امتحان کنید."


def downloading(progress: Progress) -> str:
    lines = ["⬇️ <b>در حال دانلود...</b>"]
    if progress.fraction is not None:
        percent = fa(round(progress.fraction * 100))
        lines.append(f"{progress_bar(progress.fraction)}  {percent}٪")
        size = f"{format_size(progress.downloaded)} از {format_size(progress.total)}"
    else:
        size = format_size(progress.downloaded)
    if progress.speed:
        size += f"  •  {format_size(progress.speed)}/ثانیه"
    lines.append(size)
    return "\n".join(lines)


def failed(reason: str) -> str:
    return f"❌ <b>دانلود نشد</b>\n{escape(reason)}"


def send_failed(reason: str) -> str:
    return f"❌ <b>ارسال به تلگرام ناموفق بود</b>\n{escape(reason)}"


def partly_sent(too_large: int) -> str:
    return f"✅ ارسال شد.\n⚠️ {fa(too_large)} فایل به دلیل حجم زیاد ارسال نشد."


# ------------------------------------------------------------------- results


def media_caption(media: MediaFile, bot_username: str | None = None) -> str | None:
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
        meta.append(f"⏱ {fa(format_duration(media.duration))}")
    if meta:
        lines.append("  •  ".join(meta))
    if bot_username:
        lines.append(("\n" if lines else "") + f"📥 @{bot_username}")
    return "\n".join(lines) or None


def source_keyboard(media: MediaFile) -> InlineKeyboardMarkup | None:
    if not media.webpage_url.startswith(("http://", "https://")):
        return None
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("🔗 مشاهده‌ی پست اصلی", url=media.webpage_url)]]
    )
