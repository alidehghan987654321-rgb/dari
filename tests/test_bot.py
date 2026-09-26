import asyncio
import datetime as dt
import json
from pathlib import Path
from types import SimpleNamespace

from telegram import Bot, Chat, Message, MessageEntity, Update
from telegram.request import BaseRequest

from bot import CAPTION_LIMIT, Config, extract_urls, handle_message, make_caption
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

    def __init__(self):
        self.calls = []
        self._next_id = 100

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
            result = {"id": 1, "is_bot": True, "first_name": "bot", "username": "bot"}
        elif name in ("sendChatAction", "deleteMessage"):
            result = True
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


def run_handler(text, request, **config):
    async def go():
        bot = Bot("1:fake", request=request)
        await bot.initialize()
        data = {
            "update_id": 1,
            "message": {
                "message_id": 7,
                "date": 0,
                "chat": {"id": 42, "type": "private"},
                "from": {"id": 42, "is_bot": False, "first_name": "u"},
                "text": text,
                "entities": [{"type": "url", "offset": 0, "length": utf16_len(text)}],
            },
        }
        update = Update.de_json(data, bot)
        cfg = Config(**{**BASE_CONFIG, **config})
        context = SimpleNamespace(
            bot_data={"config": cfg, "semaphore": asyncio.Semaphore(cfg.max_concurrent)}
        )
        await handle_message(update, context)

    asyncio.run(go())


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


def test_link_is_downloaded_and_sent_as_video(server):
    tg = FakeTelegram()
    run_handler(f"{server}/small.mp4", tg)

    assert tg.names() == [
        "getMe",
        "sendMessage",
        "editMessageText",
        "editMessageText",
        "sendVideo",
        "deleteMessage",
    ]
    _, params, files = next(c for c in tg.calls if c[0] == "sendVideo")
    assert params["supports_streaming"] is True
    assert params["chat_id"] == 42
    ((_, (filename, content, _)),) = files.items()
    assert filename.endswith(".mp4")
    assert len(content) == 200_000


def test_too_large_link_reports_error(server):
    tg = FakeTelegram()
    run_handler(f"{server}/big.mp4", tg)

    assert "sendVideo" not in tg.names()
    _, last, _ = [c for c in tg.calls if c[0] == "editMessageText"][-1]
    assert last["text"].startswith("❌")
    assert "مگابایت" in last["text"]
