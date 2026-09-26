import functools
import http.server
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

MB = 1024 * 1024


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
