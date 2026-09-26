import re
from pathlib import Path

import pytest

import ui
from downloader import DownloadError, MediaFile, Progress

MB = 1024 * 1024
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def media(**kwargs):
    return MediaFile(Path("a.mp4"), "video", **kwargs)


def test_both_languages_have_the_same_texts_and_placeholders():
    en, fa = ui.TEXTS["en"], ui.TEXTS["fa"]
    assert en.keys() == fa.keys()
    for key in en:
        assert set(PLACEHOLDER.findall(en[key])) == set(PLACEHOLDER.findall(fa[key])), key


@pytest.mark.parametrize(
    "code, lang",
    [("fa", "fa"), ("fa-IR", "fa"), ("en", "en"), ("en-GB", "en"), ("de", "en"), ("ar", "en")],
)
def test_pick_lang(code, lang):
    assert ui.pick_lang(code) == lang


def test_pick_lang_default_for_unknown():
    assert ui.pick_lang(None) == "en"
    assert ui.pick_lang("", default="fa") == "fa"


def test_digits():
    assert ui.num("fa", "1234.5") == "۱۲۳۴٫۵"
    assert ui.num("en", "1234.5") == "1234.5"
    assert ui.too_many_links("fa", 5) == "⚠️ فقط ۵ لینک اول دانلود می‌شود."
    assert ui.too_many_links("en", 5) == "⚠️ Only the first 5 links will be downloaded."


@pytest.mark.parametrize(
    "lang, size, text",
    [
        ("en", 512, "0 KB"),
        ("en", 300 * 1024, "300 KB"),
        ("en", 12.34 * MB, "12.3 MB"),
        ("fa", 12.34 * MB, "۱۲٫۳ مگابایت"),
    ],
)
def test_format_size(lang, size, text):
    assert ui.format_size(lang, size) == text


@pytest.mark.parametrize("seconds, text", [(5, "0:05"), (83, "1:23"), (3725, "1:02:05")])
def test_format_duration(seconds, text):
    assert ui.format_duration(seconds) == text


def test_progress_bar():
    assert ui.progress_bar(0) == "<code>░░░░░░░░░░░░</code>"
    assert ui.progress_bar(0.5) == "<code>██████░░░░░░</code>"
    assert ui.progress_bar(1.7) == "<code>████████████</code>"


def test_downloading_with_and_without_known_size():
    text = ui.downloading("en", Progress(downloaded=3 * MB, total=4 * MB, speed=MB))
    assert "75%" in text
    assert "3.0 MB of 4.0 MB" in text
    assert "1.0 MB/s" in text

    text = ui.downloading("fa", Progress(downloaded=3 * MB, total=4 * MB, speed=None))
    assert "۷۵٪" in text
    assert "۳٫۰ مگابایت از ۴٫۰ مگابایت" in text

    text = ui.downloading("en", Progress(downloaded=3 * MB, total=None, speed=None))
    assert "%" not in text
    assert text.endswith("3.0 MB")


def test_error_messages():
    error = DownloadError("too_large", limit_mb=49)
    assert (
        ui.failed("en", error)
        == "❌ <b>Download failed</b>\nThe file is bigger than the 49 MB limit."
    )
    assert "۴۹ مگابایت" in ui.failed("fa", error)
    for code in ("unsupported", "login", "private", "unavailable", "no_video", "failed"):
        for lang in ui.LANGS:
            assert ui.error_reason(lang, DownloadError(code))


def test_caption_has_title_uploader_duration_and_signature():
    item = media(title="Sunset", uploader="travel", duration=83)
    assert ui.media_caption("en", item, "mybot") == (
        "🎬 <b>Sunset</b>\n👤 travel  •  ⏱ 1:23\n\n📥 @mybot"
    )
    assert "⏱ ۱:۲۳" in ui.media_caption("fa", item)


def test_caption_escapes_html_and_squashes_long_titles():
    caption = ui.media_caption("en", media(title="a <b> & c\n\n#tag " + "x" * 1000))
    assert caption.startswith("🎬 <b>a &lt;b&gt; &amp; c #tag x")
    assert caption.endswith("…</b>")
    assert len(caption) < 1024


def test_caption_can_be_empty():
    assert ui.media_caption("en", media()) is None
    assert ui.media_caption("en", media(), "mybot") == "📥 @mybot"


def test_source_button_only_for_web_links():
    assert ui.source_keyboard("en", media(webpage_url="")) is None
    keyboard = ui.source_keyboard("fa", media(webpage_url="https://x.com/a/status/1"))
    button = keyboard.inline_keyboard[0][0]
    assert button.url == "https://x.com/a/status/1"
    assert button.text == ui.t("fa", "btn_source")


def test_welcome_keyboard_offers_the_other_language():
    for lang, other in (("en", "fa"), ("fa", "en")):
        rows = ui.welcome_keyboard(lang, "bot").inline_keyboard
        assert rows[-1][0].callback_data == ui.CB_LANG + other


def test_outside_text_is_escaped():
    assert "&lt;Channel&gt;" in ui.channel_added("en", "<Channel>", can_post=True)
    assert ui.send_failed("en", "<oops>").endswith("&lt;oops&gt;")


@pytest.mark.parametrize("lang", ui.LANGS)
def test_texts_fit_telegram_limits(lang):
    assert len(ui.t(lang, "short_description")) <= 120
    assert len(ui.t(lang, "description")) <= 512
    assert len(ui.welcome(lang)) <= 1024  # it's a photo caption
    assert len(ui.help_text(lang, 2000)) <= 1024
    for cmd in ("start", "dl", "lang"):
        assert 1 <= len(ui.t(lang, f"cmd_{cmd}")) <= 256
