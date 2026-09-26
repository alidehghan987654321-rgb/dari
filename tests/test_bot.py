import asyncio
import datetime as dt
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from telegram import Bot, Chat, Message, MessageEntity, Update
from telegram.request import BaseRequest

import bot as botmod
from bot import (
    CAPTION_LIMIT,
    Config,
    dl_command,
    extract_urls,
    handle_message,
    make_caption,
    on_my_chat_member,
    start,
)
from downloader import MediaFile

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


def test_caption():
    assert make_caption(MediaFile(Path("a.mp4"), "video", title="  ")) is None
    assert make_caption(MediaFile(Path("a.mp4"), "video", title="Hi")) == "Hi"
    long = make_caption(MediaFile(Path("a.mp4"), "video", title="x" * 5000))
    assert len(long) == CAPTION_LIMIT


class FakeTelegram(BaseRequest):
    """Stands in for api.telegram.org and records every call the bot makes."""

    def __init__(self, privacy_mode=True):
        self.calls = []
        self._next_id = 100
        self.privacy_mode = privacy_mode

    @property
    def read_timeout(self):
        return None

    async def initialize(self):
        pass

    async def shutdown(self):
        pass

    async def do_request(self, url, method, request_data=None, **kwargs):
        name = url.rsplit("/", 1)[-1]
        params = dict(request_data.parameters) if request_data else {}
        files = request_data.multipart_data if request_data and request_data.contains_files else {}
        self.calls.append((name, params, files))
        if name == "getMe":
            result = {**BOT_USER, "can_read_all_group_messages": not self.privacy_mode}
        elif name in ("sendChatAction", "deleteMessage"):
            result = True
        elif name == "getChatMember":
            result = {"status": "member", "user": BOT_USER}
        else:
            self._next_id += 1
            result = {
                "message_id": self._next_id,
                "date": 0,
                "chat": {"id": params.get("chat_id", 42), "type": "private"},
                "text": params.get("text", ""),
            }
        return 200, json.dumps({"ok": True, "result": result}).encode()

    def names(self):
        return [name for name, _, _ in self.calls if name != "sendChatAction"]


BOT_USER = {"id": 1, "is_bot": True, "first_name": "bot", "username": "bot"}
USER = {"id": 42, "is_bot": False, "first_name": "u"}
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
}


def message_json(text, chat="private", reply_to=None):
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
        msg["from"] = USER
    if reply_to:
        msg["reply_to_message"] = {**message_json(reply_to, chat), "message_id": 6}
    return msg


def run(handler, tg, update, **config):
    """Call ``handler`` with ``update`` (a dict) against the fake Telegram API."""

    async def go():
        bot = Bot("1:fake", request=tg)
        await bot.initialize()
        cfg = Config(**{**BASE_CONFIG, **config})
        context = SimpleNamespace(
            bot=bot,
            args=[],
            bot_data={"config": cfg, "semaphore": asyncio.Semaphore(cfg.max_concurrent)},
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


def test_link_is_downloaded_and_sent_as_video(server):
    tg = FakeTelegram()
    run(handle_message, tg, post(f"{server}/small.mp4"))

    assert tg.names() == ["getMe", "sendMessage", "editMessageText", "sendVideo", "deleteMessage"]
    _, params, files = next(c for c in tg.calls if c[0] == "sendVideo")
    assert params["supports_streaming"] is True
    assert params["chat_id"] == 42
    ((_, (filename, content, _)),) = files.items()
    assert filename.endswith(".mp4")
    assert len(content) == 200_000


def test_too_large_link_reports_error(server):
    tg = FakeTelegram()
    run(handle_message, tg, post(f"{server}/big.mp4"))

    assert sent_videos(tg) == []
    _, last, _ = [c for c in tg.calls if c[0] == "editMessageText"][-1]
    assert last["text"].startswith("❌")
    assert "مگابایت" in last["text"]


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


def test_dl_command_downloads_link_from_replied_message(server):
    tg = FakeTelegram()
    run(dl_command, tg, post("/dl", "supergroup", reply_to=f"look {server}/small.mp4"))

    # Explicit command, so progress is shown even in a group.
    assert tg.names() == ["getMe", "sendMessage", "editMessageText", "sendVideo", "deleteMessage"]


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


def test_start_in_private_offers_add_to_group_and_channel_buttons():
    tg = FakeTelegram()
    run(start, tg, post("/start"))

    params = tg.calls[-1][1]
    urls = [b["url"] for row in params["reply_markup"]["inline_keyboard"] for b in row]
    assert urls == [
        "https://t.me/bot?startgroup=add",
        "https://t.me/bot?startchannel=add&admin=post_messages",
    ]


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
    assert "ادمین" in params["text"]  # privacy mode: asks to be made admin


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
