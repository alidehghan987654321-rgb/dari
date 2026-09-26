import functools
import http.server
import json
import sys
import threading
from pathlib import Path

import pytest
from telegram.error import NetworkError
from telegram.request import BaseRequest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

MB = 1024 * 1024
BOT_USER = {"id": 1, "is_bot": True, "first_name": "bot", "username": "bot"}


@pytest.fixture
def server(tmp_path, monkeypatch):
    """Serve a couple of fake videos over HTTP on localhost; yield the base URL."""
    www = tmp_path / "www"
    www.mkdir()
    (www / "small.mp4").write_bytes(b"\0" * 200_000)
    (www / "big.mp4").write_bytes(b"\0" * (2 * MB))
    for var in ("NO_PROXY", "no_proxy"):
        monkeypatch.setenv(var, "127.0.0.1,localhost")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Handler, directory=str(www))
    )
    # yt-dlp hangs up mid-transfer on files over the limit; don't print that.
    httpd.handle_error = lambda *args: None
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()


class FakeTelegram(BaseRequest):
    """Stands in for api.telegram.org and records every call the bot makes."""

    def __init__(self, privacy_mode=True, profile_done=False, down=False):
        self.calls = []
        self.down = down  # Telegram unreachable
        self._next_id = 100
        self.privacy_mode = privacy_mode
        self.profile_done = profile_done  # description and picture already set

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
        if self.down:
            raise NetworkError("Telegram is unreachable")
        if name == "getMe":
            result = {**BOT_USER, "can_read_all_group_messages": not self.privacy_mode}
        elif name in (
            "sendChatAction",
            "deleteMessage",
            "answerCallbackQuery",
            "setWebhook",
        ) or name.startswith("setMy"):
            result = True
        elif name == "getChatMember":
            result = {"status": "member", "user": BOT_USER}
        elif name == "getMyShortDescription":
            result = {"short_description": "set" if self.profile_done else ""}
        elif name == "getMyDescription":
            result = {"description": "set" if self.profile_done else ""}
        elif name == "getUserProfilePhotos":
            result = {"total_count": int(self.profile_done), "photos": []}
        else:
            self._next_id += 1
            result = {
                "message_id": self._next_id,
                "date": 0,
                "chat": {"id": params.get("chat_id", 42), "type": "private"},
                "text": params.get("text", ""),
            }
            if name in ("sendPhoto", "editMessageMedia"):
                photo = {"file_id": f"id-{self._next_id}", "file_unique_id": "u"}
                photo |= {"width": 1, "height": 1}
                result["photo"] = [photo]
        return 200, json.dumps({"ok": True, "result": result}).encode()

    def names(self):
        return [name for name, _, _ in self.calls if name != "sendChatAction"]

    def texts(self):
        """Texts of the status message, in the order they were shown."""
        return [p["text"] for n, p, _ in self.calls if n in ("sendMessage", "editMessageText")]

    def last(self, name):
        return [params for n, params, _ in self.calls if n == name][-1]
