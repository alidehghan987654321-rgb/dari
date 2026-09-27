"""Persian names for products, with Claude. Each product is named once and remembered.

Optional: it runs when ANTHROPIC_API_KEY is set (and the `anthropic` package is
installed, see hunter/requirements.txt). The model is HUNTER_CLAUDE_MODEL, by default
claude-opus-5; a cheaper model such as claude-haiku-4-5 also does this job. Titles go
25 to a request and the answer is a JSON list, so a product costs well under a cent.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-opus-5"
BATCH = 25
SYSTEM = (
    "You name e-commerce products in Persian for Iranian sellers who import from China. "
    "For each item, write a short, natural Persian product name (at most 8 words) that "
    "says what the product is. Keep pack counts and sizes (for example «۲ عددی»), keep "
    "brand names as they are, and drop marketing words. Answer for every id you are given."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "fa": {"type": "string"}},
                "required": ["id", "fa"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def _supports_effort(model: str) -> bool:
    return model.startswith(("claude-opus-5", "claude-sonnet-5", "claude-fable"))


def _server_fallback(model: str) -> bool:
    # A request these models decline is retried on Claude Opus 4.8 by the API itself.
    return model.startswith(("claude-opus-5", "claude-fable-5"))


class PersianNamer:
    def __init__(self, client: Any, model: str = DEFAULT_MODEL):
        self.client = client
        self.model = model

    @classmethod
    def from_env(cls) -> PersianNamer | None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            return None
        try:
            import anthropic
        except ImportError:
            log.warning(
                "ANTHROPIC_API_KEY is set but `anthropic` isn't installed; no Persian names"
            )
            return None
        return cls(anthropic.Anthropic(), os.environ.get("HUNTER_CLAUDE_MODEL") or DEFAULT_MODEL)

    def translate(self, titles: dict[str, str]) -> dict[str, str]:
        """{key: title} -> {key: Persian name}. Failed batches are skipped, not fatal."""
        names: dict[str, str] = {}
        items = list(titles.items())
        for i in range(0, len(items), BATCH):
            chunk = dict(items[i : i + BATCH])
            try:
                names.update(self._ask(chunk))
            except Exception:
                log.exception("Naming %d products in Persian failed", len(chunk))
        return names

    def _ask(self, chunk: dict[str, str]) -> dict[str, str]:
        output_config: dict[str, Any] = {"format": {"type": "json_schema", "schema": SCHEMA}}
        if _supports_effort(self.model):
            output_config["effort"] = "low"
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": 8000,
            "system": SYSTEM,
            "messages": [
                {
                    "role": "user",
                    "content": json.dumps(
                        [{"id": k, "title": t} for k, t in chunk.items()], ensure_ascii=False
                    ),
                }
            ],
            "output_config": output_config,
        }
        if _server_fallback(self.model):
            response = self.client.beta.messages.create(
                betas=["server-side-fallback-2026-06-01"],
                fallbacks=[{"model": "claude-opus-4-8"}],
                **params,
            )
        else:
            response = self.client.messages.create(**params)
        if response.stop_reason != "end_turn":  # refusal, or cut off by max_tokens
            log.warning("Persian names: stopped with %s", response.stop_reason)
            return {}
        text = next((b.text for b in response.content if b.type == "text"), "")
        items = json.loads(text).get("items", [])
        return {
            x["id"]: x["fa"].strip()
            for x in items
            if isinstance(x, dict) and x.get("id") in chunk and str(x.get("fa", "")).strip()
        }


def name_candidates(candidates: list[dict], namer: PersianNamer | None, db) -> None:
    """Give candidates without a Persian name one: remembered names first, then Claude
    for the rest (and remember those)."""
    need = {
        f"{c['listing']['source']}:{c['listing']['id']}": c
        for c in candidates
        if not c.get("title_fa") and c.get("listing", {}).get("title")
    }
    if not need:
        return
    known = db.names(list(need))
    missing = {k: c["listing"]["title"] for k, c in need.items() if k not in known}
    if missing and namer:
        fresh = namer.translate(missing)
        if fresh:
            db.save_names(fresh)
            known.update(fresh)
    for key, c in need.items():
        if key in known:
            c["title_fa"] = known[key]
