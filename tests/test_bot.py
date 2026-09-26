import asyncio
import datetime as dt
import json
import time
from types import SimpleNamespace

import pytest
from conftest import BOT_USER, FakeTelegram
from telegram import Bot, Chat, Message, MessageEntity, Update

import bot as botmod
import ui
from bot import (
    Config,
    dl_command,
    extract_urls,
    handle_message,
    on_menu_button,
    on_my_chat_member,
    setup_profile,
    start,
    switch_language,
)
from downloader import DownloadResult, MediaFile, Progress

CHAT = Chat(id=1, type=Chat.PRIVATE)
DATE = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)


def utf16_len(s):
    return len(s.encode("utf-16-le")) // 2


def message_with_urls(text, urls, caption=False):
    entities = []
    for url in urls:
        offset = utf16_len(text[: text.index(url)])
        entities.append(MessageEntity(MessageEntity.URL, offset, utf16_len(url)))
    if caption:
        return Message(1, DATE, CHAT, caption=text, caption_entities=entities)
    return Message(1, DATE, CHAT, text=text, entities=entities)


def test_extracts_urls_in_order_without_duplicates():
    a = "https://www.instagram.com/reel/abc/"
    b = "https://vm.tiktok.com/xyz/"
    msg = message_with_urls(f"ببین {a} و {b} و {a}", [a, b])
    assert extract_urls(msg) == [a, b]


def test_adds_scheme_to_bare_links():
    msg = message_with_urls("youtube.com/watch?v=1", ["youtube.com/watch?v=1"])
    assert extract_urls(msg) == ["https://youtube.com/watch?v=1"]


def test_extracts_hidden_text_links_and_captions():
    hidden = MessageEntity(MessageEntity.TEXT_LINK, 0, 4, url="https://x.com/i/status/1")
    msg = Message(1, DATE, CHAT, text="this", entities=[hidden])
    assert extract_urls(msg) == ["https://x.com/i/status/1"]

    url = "https://www.tiktok.com/@a/video/1"
    assert extract_urls(message_with_urls(f"💥 {url}", [url], caption=True)) == [url]


def test_ignores_non_http_links():
    msg = message_with_urls("ftp://example.com/a", ["ftp://example.com/a"])
    assert extract_urls(msg) == []


def test_no_urls():
    assert extract_urls(Message(1, DATE, CHAT, text="سلام")) == []


USER = {"id": 42, "is_bot": False, "first_name": "u", "language_code": "en"}
PERSIAN_USER = {**USER, "language_code": "fa"}
CHATS = {
    "private": {"id": 42, "type": "private"},
    "supergroup": {"id": -1001, "type": "supergroup", "title": "Group"},
    "channel": {"id": -1002, "type": "channel", "title": "Channel"},
}
BASE_CONFIG = {
    "token": "1:fake",
    "allowed_users": frozenset(),
    "max_bytes": 1024 * 1024,
    "max_height": 720,
    "max_items": 10,
    "max_concurrent": 2,
    "cookies_file": None,
    "proxy": None,
    "bot_api_url": None,
    "bot_api_file_url": None,
    "site_url": None,
}


def message_json(text, chat="private", reply_to=None, user=USER):
    """A message dict with entities for every link and a leading /command."""
    entities = []
    offset = 0
    for word in text.split(" "):
        if word.startswith("http"):
            entities.append({"type": "url", "offset": offset, "length": utf16_len(word)})
        elif word.startswith("/") and offset == 0:
            entities.append({"type": "bot_command", "offset": 0, "length": utf16_len(word)})
        offset += utf16_len(word) + 1
    msg = {"message_id": 7, "date": 0, "chat": CHATS[chat], "text": text, "entities": entities}
    if chat != "channel":
        msg["from"] = user
    if reply_to:
        msg["reply_to_message"] = {**message_json(reply_to, chat), "message_id": 6}
    return msg


def run(handler, tg, update, bot_data=None, user_data=None, **config):
    """Call ``handler`` with ``update`` (a dict) against the fake Telegram API."""

    async def go():
        bot = Bot("1:fake", request=tg)
        await bot.initialize()
        cfg = Config(**{**BASE_CONFIG, **config})
        data = bot_data if bot_data is not None else {}
        data.setdefault("config", cfg)
        data.setdefault("semaphore", asyncio.Semaphore(cfg.max_concurrent))
        context = SimpleNamespace(
            bot=bot, args=[], bot_data=data, user_data=user_data if user_data is not None else {}
        )
        await handler(Update.de_json({"update_id": 1, **update}, bot), context)

    asyncio.run(go())


def post(text, chat="private", **kwargs):
    key = "channel_post" if chat == "channel" else "message"
    return {key: message_json(text, chat, **kwargs)}


@pytest.fixture
def any_link_is_video(monkeypatch):
    """Treat the local test server's links like Instagram/TikTok links."""
    monkeypatch.setattr(botmod, "is_video_link", lambda url: True)


def sent_videos(tg):
    return [params for name, params, _ in tg.calls if name == "sendVideo"]


def without_progress(names):
    # Progress edits depend on timing; the tests below check them separately.
    return [n for n in names if n != "editMessageText"]


def test_link_is_downloaded_and_sent_as_video(server):
    tg = FakeTelegram()
    run(handle_message, tg, post(f"{server}/small.mp4"))

    assert without_progress(tg.names()) == ["getMe", "sendMessage", "sendVideo", "deleteMessage"]
    assert tg.texts()[0] == ui.t("en", "checking")
    assert tg.texts()[-1] == ui.t("en", "sending")
    _, params, files = next(c for c in tg.calls if c[0] == "sendVideo")
    assert params["supports_streaming"] is True
    assert params["chat_id"] == 42
    assert params["parse_mode"] == "HTML"
    assert params["caption"].endswith("📥 @bot")
    (button,) = params["reply_markup"]["inline_keyboard"][0]
    assert button["url"] == f"{server}/small.mp4"
    ((_, (filename, content, _)),) = files.items()
    assert filename.endswith(".mp4")
    assert len(content) == 200_000


def test_progress_bar_is_shown_while_downloading(monkeypatch, tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"\0" * 10)

    def fake_download(url, dest, *, progress, **kwargs):
        progress(Progress(downloaded=512 * 1024, total=1024 * 1024, speed=None))
        time.sleep(0.3)
        return DownloadResult(files=[MediaFile(video, "video")])

    monkeypatch.setattr(botmod, "download", fake_download)
    monkeypatch.setattr(botmod, "PROGRESS_INTERVAL", 0.05)
    tg = FakeTelegram()
    run(handle_message, tg, post("https://www.instagram.com/reel/abc/"))

    texts = tg.texts()
    assert texts[0] == ui.t("en", "checking")
    assert texts[1] == ui.downloading("en", Progress(512 * 1024, 1024 * 1024, None))
    assert "50%" in texts[1]
    assert texts[2] == ui.t("en", "sending")
    assert len(texts) == 3  # unchanged progress isn't re-sent


def test_too_large_link_reports_error(server):
    tg = FakeTelegram()
    run(handle_message, tg, post(f"{server}/big.mp4"))

    assert sent_videos(tg) == []
    _, last, _ = [c for c in tg.calls if c[0] == "editMessageText"][-1]
    assert last["text"].startswith("❌")
    assert "1 MB" in last["text"]


def test_private_chat_without_link_gets_a_hint():
    tg = FakeTelegram()
    run(handle_message, tg, post("سلام"))
    assert tg.names() == ["getMe", "sendMessage"]


def test_group_ignores_links_that_are_not_videos(server):
    tg = FakeTelegram()
    run(
        handle_message, tg, post(f"see https://github.com/a/b and {server}/small.mp4", "supergroup")
    )
    run(handle_message, tg, post("just chatting", "supergroup"))
    assert tg.names() == ["getMe", "getMe"]


def test_group_video_link_is_answered_with_just_the_video(server, any_link_is_video):
    tg = FakeTelegram()
    run(handle_message, tg, post(f"{server}/small.mp4", "supergroup"))

    assert tg.names() == ["getMe", "sendVideo"]
    (params,) = sent_videos(tg)
    assert params["chat_id"] == CHATS["supergroup"]["id"]
    assert params["reply_parameters"]["message_id"] == 7


def test_group_failures_are_silent(server, any_link_is_video):
    tg = FakeTelegram()
    run(handle_message, tg, post(f"{server}/big.mp4", "supergroup"))
    assert tg.names() == ["getMe"]


def test_channel_post_gets_the_video_as_a_reply(server, any_link_is_video):
    tg = FakeTelegram()
    run(handle_message, tg, post(f"new reel {server}/small.mp4", "channel"))

    assert tg.names() == ["getMe", "sendVideo"]
    (params,) = sent_videos(tg)
    assert params["chat_id"] == CHATS["channel"]["id"]
    assert params["reply_parameters"]["message_id"] == 7
    assert "@bot" not in (params.get("caption") or "")  # no advertising in someone's channel


def test_dl_command_downloads_link_from_replied_message(server):
    tg = FakeTelegram()
    run(dl_command, tg, post("/dl", "supergroup", reply_to=f"look {server}/small.mp4"))

    # Explicit command, so progress is shown even in a group.
    assert without_progress(tg.names()) == ["getMe", "sendMessage", "sendVideo", "deleteMessage"]
    assert tg.texts()[-1] == ui.t("en", "sending")


def test_dl_command_shows_errors_in_groups(server):
    tg = FakeTelegram()
    run(dl_command, tg, post(f"/dl {server}/big.mp4", "supergroup"))

    assert sent_videos(tg) == []
    _, last, _ = [c for c in tg.calls if c[0] == "editMessageText"][-1]
    assert last["text"].startswith("❌")


def test_dl_command_without_link_explains_usage():
    tg = FakeTelegram()
    run(dl_command, tg, post("/dl", "supergroup"))

    assert tg.names() == ["getMe", "sendMessage"]
    assert "/dl" in tg.calls[-1][1]["text"]


def test_start_in_private_shows_banner_with_buttons():
    tg = FakeTelegram()
    bot_data = {}
    run(start, tg, post("/start"), bot_data=bot_data)

    assert tg.names() == ["getMe", "sendPhoto"]
    _, params, files = tg.calls[-1]
    assert params["caption"] == ui.welcome("en")
    assert params["parse_mode"] == "HTML"
    assert "photo" in files  # uploaded from assets/banner.png
    rows = params["reply_markup"]["inline_keyboard"]
    assert [b["url"] for b in rows[0]] == [
        "https://t.me/bot?startgroup=add",
        "https://t.me/bot?startchannel=add&admin=post_messages",
    ]
    assert rows[1][0]["callback_data"] == ui.CB_HELP
    assert rows[2][0]["callback_data"] == ui.CB_LANG + "fa"

    # The second time Telegram's copy of the banner is reused.
    uploaded = bot_data["banner_file_ids"]["en"]
    run(start, tg, post("/start"), bot_data=bot_data)
    _, params, files = tg.calls[-1]
    assert params["photo"] == uploaded
    assert not files


def test_start_links_to_the_website_when_there_is_one():
    tg = FakeTelegram()
    run(start, tg, post("/start"), site_url="https://dl.gryffin.uk")
    help_row = tg.last("sendPhoto")["reply_markup"]["inline_keyboard"][1]
    assert help_row[1] == {"text": "🌐 Website", "url": "https://dl.gryffin.uk"}


def test_site_url_comes_from_domain(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "1:x")
    monkeypatch.setenv("DOMAIN", "dl.gryffin.uk")
    assert Config.from_env().site_url == "https://dl.gryffin.uk"
    monkeypatch.setenv("DOMAIN", "localhost")
    assert Config.from_env().site_url is None


def test_start_without_banner_falls_back_to_text(monkeypatch, tmp_path):
    monkeypatch.setattr(botmod, "BANNERS", {"en": tmp_path / "x.png", "fa": tmp_path / "y.png"})
    tg = FakeTelegram()
    run(start, tg, post("/start"))
    assert tg.names() == ["getMe", "sendMessage"]
    assert tg.last("sendMessage")["text"] == ui.welcome("en")


def menu_press(data, user=USER):
    photo = [{"file_id": "banner-id", "file_unique_id": "u", "width": 1, "height": 1}]
    message = {"message_id": 9, "date": 0, "chat": CHATS["private"], "photo": photo}
    return {
        "callback_query": {
            "id": "1",
            "from": user,
            "chat_instance": "c",
            "data": data,
            "message": message,
        }
    }


def test_help_and_back_buttons_edit_the_welcome_message():
    tg = FakeTelegram()
    run(on_menu_button, tg, menu_press(ui.CB_HELP))

    assert tg.names() == ["getMe", "answerCallbackQuery", "editMessageCaption"]
    params = tg.last("editMessageCaption")
    assert params["caption"] == ui.help_text("en", 1)
    assert params["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == ui.CB_HOME

    run(on_menu_button, tg, menu_press(ui.CB_HOME))
    params = tg.last("editMessageCaption")
    assert params["caption"] == ui.welcome("en")
    assert params["reply_markup"]["inline_keyboard"][1][0]["callback_data"] == ui.CB_HELP


def run_setup_profile(tg):
    async def go():
        bot = Bot("1:fake", request=tg)
        await bot.initialize()
        await setup_profile(bot)

    asyncio.run(go())


def test_profile_is_set_up_on_first_start():
    tg = FakeTelegram(profile_done=False)
    run_setup_profile(tg)

    short = [p for n, p, _ in tg.calls if n == "setMyShortDescription"]
    assert [(p["short_description"], p.get("language_code")) for p in short] == [
        (ui.t("en", "short_description"), None),  # default, for everyone
        (ui.t("fa", "short_description"), "fa"),  # Persian Telegram apps
    ]
    long = [p for n, p, _ in tg.calls if n == "setMyDescription"]
    assert [p.get("language_code") for p in long] == [None, "fa"]
    _, _, files = next(c for c in tg.calls if c[0] == "setMyProfilePhoto")
    assert files  # assets/avatar.png is uploaded


def test_profile_set_by_owner_is_left_alone():
    tg = FakeTelegram(profile_done=True)
    run_setup_profile(tg)
    assert not [n for n in tg.names() if n.startswith("set")]


def test_help_in_group_mentions_admin_only_if_needed():
    tg = FakeTelegram(privacy_mode=True)
    run(start, tg, post("/help", "supergroup"))
    assert tg.names() == ["getMe", "getChatMember", "sendMessage"]
    assert "⚠️" in tg.calls[-1][1]["text"]

    tg = FakeTelegram(privacy_mode=False)
    run(start, tg, post("/help", "supergroup"))
    assert tg.names() == ["getMe", "sendMessage"]
    assert "⚠️" not in tg.calls[-1][1]["text"]


def admin(**rights):
    names = [
        "can_be_edited",
        "is_anonymous",
        "can_manage_chat",
        "can_delete_messages",
        "can_manage_video_chats",
        "can_restrict_members",
        "can_promote_members",
        "can_change_info",
        "can_invite_users",
        "can_post_stories",
        "can_edit_stories",
        "can_delete_stories",
    ]
    return {"status": "administrator", "user": BOT_USER, **dict.fromkeys(names, False), **rights}


def membership(chat, old, new):
    return {
        "my_chat_member": {
            "chat": CHATS[chat],
            "from": USER,
            "date": 0,
            "old_chat_member": {"status": old, "user": BOT_USER} if isinstance(old, str) else old,
            "new_chat_member": {"status": new, "user": BOT_USER} if isinstance(new, str) else new,
        }
    }


def test_welcome_when_added_to_group():
    tg = FakeTelegram(privacy_mode=True)
    run(on_my_chat_member, tg, membership("supergroup", "left", "member"))

    assert tg.names() == ["getMe", "sendMessage"]
    params = tg.calls[-1][1]
    assert params["chat_id"] == CHATS["supergroup"]["id"]
    assert "/dl" in params["text"]
    assert "admin" in params["text"]  # privacy mode: asks to be made admin


def test_welcome_skips_admin_hint_when_bot_sees_all_messages():
    tg = FakeTelegram(privacy_mode=False)
    run(on_my_chat_member, tg, membership("supergroup", "left", "member"))
    assert "⚠️" not in tg.calls[-1][1]["text"]

    tg = FakeTelegram(privacy_mode=True)
    run(on_my_chat_member, tg, membership("supergroup", "left", admin()))
    assert "⚠️" not in tg.calls[-1][1]["text"]


def test_no_welcome_when_removed_or_promoted_in_group():
    tg = FakeTelegram()
    run(on_my_chat_member, tg, membership("supergroup", "member", "left"))
    run(on_my_chat_member, tg, membership("supergroup", "member", admin()))
    assert tg.names() == ["getMe", "getMe"]


def test_whoever_adds_bot_to_channel_gets_a_private_message():
    tg = FakeTelegram()
    run(on_my_chat_member, tg, membership("channel", "left", admin(can_post_messages=True)))

    assert tg.names() == ["getMe", "sendMessage"]
    params = tg.calls[-1][1]
    assert params["chat_id"] == USER["id"]
    assert "Channel" in params["text"]
    assert "⚠️" not in params["text"]


def test_channel_admin_without_post_right_is_warned():
    tg = FakeTelegram()
    run(on_my_chat_member, tg, membership("channel", "left", admin(can_post_messages=False)))
    assert "⚠️" in tg.calls[-1][1]["text"]


# ------------------------------------------------------------------ languages


def test_persian_telegram_users_get_persian(tmp_path, monkeypatch):
    tg = FakeTelegram()
    run(start, tg, post("/start", user=PERSIAN_USER))
    _, params, files = tg.calls[-1]
    assert params["caption"] == ui.welcome("fa")
    assert files["photo"][0] == "banner.png"  # the Persian banner

    run(handle_message, tg, post("hello", user=PERSIAN_USER))
    assert tg.last("sendMessage")["text"] == ui.t("fa", "no_link")


def test_everyone_else_gets_english():
    tg = FakeTelegram()
    for code in ("en", "de", "ar"):
        run(handle_message, tg, post("hello", user={**USER, "language_code": code}))
        assert tg.last("sendMessage")["text"] == ui.t("en", "no_link")


def test_persian_progress_uses_persian_digits(monkeypatch, tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"\0" * 10)

    def fake_download(url, dest, *, progress, **kwargs):
        progress(Progress(downloaded=512 * 1024, total=1024 * 1024, speed=None))
        time.sleep(0.3)
        return DownloadResult(files=[MediaFile(video, "video", duration=83)])

    monkeypatch.setattr(botmod, "download", fake_download)
    monkeypatch.setattr(botmod, "PROGRESS_INTERVAL", 0.05)
    tg = FakeTelegram()
    run(handle_message, tg, post("https://www.instagram.com/reel/abc/", user=PERSIAN_USER))

    assert "۵۰٪" in tg.texts()[1]
    assert "۱:۲۳" in tg.last("sendVideo")["caption"]


def test_language_button_switches_and_swaps_the_banner():
    tg = FakeTelegram()
    user_data = {}
    run(on_menu_button, tg, menu_press(ui.CB_LANG + "fa"), user_data=user_data)

    assert user_data["lang"] == "fa"
    params = tg.last("editMessageMedia")
    media = json.loads(params["media"]) if isinstance(params["media"], str) else params["media"]
    assert media["caption"] == ui.welcome("fa")
    assert params["reply_markup"]["inline_keyboard"][2][0]["callback_data"] == ui.CB_LANG + "en"

    # The choice sticks, whatever the Telegram app's language.
    run(handle_message, tg, post("hello"), user_data=user_data)
    assert tg.last("sendMessage")["text"] == ui.t("fa", "no_link")


def test_lang_command_flips_the_language():
    tg = FakeTelegram()
    user_data = {}
    run(switch_language, tg, post("/lang"), user_data=user_data)
    assert user_data["lang"] == "fa"
    assert tg.last("sendPhoto")["caption"] == ui.welcome("fa")

    run(switch_language, tg, post("/lang", "supergroup"), user_data=user_data)
    assert user_data["lang"] == "en"
    assert tg.last("sendMessage")["text"] == ui.t("en", "lang_switched")


def test_join_messages_use_the_language_of_whoever_added_the_bot():
    tg = FakeTelegram()
    update = membership("supergroup", "left", "member")
    update["my_chat_member"]["from"] = PERSIAN_USER
    run(on_my_chat_member, tg, update)
    assert tg.last("sendMessage")["text"] == ui.group_help("fa", sees_all_messages=False)


def test_default_language_setting(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "1:x")
    assert Config.from_env().default_lang == "en"
    monkeypatch.setenv("DEFAULT_LANGUAGE", "fa")
    assert Config.from_env().default_lang == "fa"

    # Users whose app doesn't report a language get the default.
    tg = FakeTelegram()
    no_lang = {k: v for k, v in USER.items() if k != "language_code"}
    run(handle_message, tg, post("hello", user=no_lang), default_lang="fa")
    assert tg.last("sendMessage")["text"] == ui.t("fa", "no_link")
