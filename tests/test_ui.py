from pathlib import Path

import pytest

import ui
from downloader import MediaFile, Progress

MB = 1024 * 1024


def media(**kwargs):
    return MediaFile(Path("a.mp4"), "video", **kwargs)


def test_persian_digits():
    assert ui.fa(1234.5) == "۱۲۳۴٫۵"
    assert ui.fa("0:42") == "۰:۴۲"


@pytest.mark.parametrize(
    "size, text",
    [(512, "۰ کیلوبایت"), (300 * 1024, "۳۰۰ کیلوبایت"), (12.34 * MB, "۱۲٫۳ مگابایت")],
)
def test_format_size(size, text):
    assert ui.format_size(size) == text


@pytest.mark.parametrize("seconds, text", [(5, "0:05"), (83, "1:23"), (3725, "1:02:05")])
def test_format_duration(seconds, text):
    assert ui.format_duration(seconds) == text


def test_progress_bar():
    assert ui.progress_bar(0) == "<code>░░░░░░░░░░░░</code>"
    assert ui.progress_bar(0.5) == "<code>██████░░░░░░</code>"
    assert ui.progress_bar(1.7) == "<code>████████████</code>"


def test_downloading_with_and_without_known_size():
    text = ui.downloading(Progress(downloaded=3 * MB, total=4 * MB, speed=MB))
    assert "۷۵٪" in text
    assert "۳٫۰ مگابایت از ۴٫۰ مگابایت" in text
    assert "۱٫۰ مگابایت/ثانیه" in text

    text = ui.downloading(Progress(downloaded=3 * MB, total=None, speed=None))
    assert "٪" not in text
    assert text.endswith("۳٫۰ مگابایت")


def test_caption_has_title_uploader_duration_and_signature():
    caption = ui.media_caption(media(title="Sunset", uploader="travel", duration=83), "mybot")
    assert caption == "🎬 <b>Sunset</b>\n👤 travel  •  ⏱ ۱:۲۳\n\n📥 @mybot"


def test_caption_escapes_html_and_squashes_long_titles():
    caption = ui.media_caption(media(title="a <b> & c\n\n#tag " + "x" * 1000))
    assert caption.startswith("🎬 <b>a &lt;b&gt; &amp; c #tag x")
    assert caption.endswith("…</b>")
    assert len(caption) < 1024


def test_caption_can_be_empty():
    assert ui.media_caption(media()) is None
    assert ui.media_caption(media(), "mybot") == "📥 @mybot"


def test_source_button_only_for_web_links():
    assert ui.source_keyboard(media(webpage_url="")) is None
    keyboard = ui.source_keyboard(media(webpage_url="https://x.com/a/status/1"))
    assert keyboard.inline_keyboard[0][0].url == "https://x.com/a/status/1"


def test_error_text_is_escaped():
    assert ui.failed("<oops>") == "❌ <b>دانلود نشد</b>\n&lt;oops&gt;"
    assert "&lt;" in ui.channel_added("<Channel>", can_post=True)


def test_texts_fit_telegram_limits():
    assert len(ui.SHORT_DESCRIPTION) <= 120
    assert len(ui.DESCRIPTION) <= 512
    assert len(ui.WELCOME) <= 1024  # it's a photo caption
    assert len(ui.help_text(2000)) <= 1024
