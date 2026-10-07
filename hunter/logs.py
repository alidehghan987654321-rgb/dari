"""Logging that never writes an API key down.

Keepa takes its key in the link (``?key=...``), and httpx logs every request's link at INFO,
so without this the key would sit in the server's logs (on Cloudflare, in the dashboard's
log viewer) and in the text of any error that prints the link. Every handler gets a filter
that blanks the value of secret-looking parameters, in the message and in the traceback.
"""

from __future__ import annotations

import logging
import re

SECRET_PARAM = re.compile(
    r"((?:[?&]|\b)(?:key|token|api_?key|access_?token|secret|password|merchant_?id)=)"
    r"[^&\s\"'#<>]+",
    re.IGNORECASE,
)
QUIET = ("httpx", "httpcore")  # they log each request's full link at INFO


def redact(text: str) -> str:
    return SECRET_PARAM.sub(r"\1***", text)


class Redact(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        clean = redact(message)
        if clean != message:
            record.msg, record.args = clean, None
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = redact(record.exc_text)
        return True


def install(*loggers: str) -> None:
    """Adds the filter to the handlers of the root logger and of ``loggers`` (uvicorn's),
    and keeps httpx's per-request lines out of the log."""
    for name in QUIET:
        logging.getLogger(name).setLevel(logging.WARNING)
    for name in ("", *loggers):
        for handler in logging.getLogger(name).handlers:
            if not any(isinstance(f, Redact) for f in handler.filters):
                handler.addFilter(Redact())
