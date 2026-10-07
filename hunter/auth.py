"""Passwords, session tokens and throttling."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import time
from collections import deque
from functools import cache

# scrypt at one of OWASP's recommended settings (N=2^14, r=8, p=5: 16 MiB, five passes).
# Hashes made with weaker settings are upgraded on the next successful login (needs_rehash).
N, R, P = 2**14, 8, 5
MAXMEM = 64 * 1024 * 1024
# At most this many hashes at once: each takes 16 MiB, so a burst of logins can't use up the
# server's memory.
_HASHING = threading.BoundedSemaphore(4)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    with _HASHING:
        digest = hashlib.scrypt(
            password.encode(), salt=salt, n=N, r=R, p=P, maxmem=MAXMEM, dklen=32
        )
    b64 = base64.b64encode
    return f"scrypt${N}${R}${P}${b64(salt).decode()}${b64(digest).decode()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        n, r, p = int(n), int(r), int(p)
        if n > 2**16 or r > 8 or p > 16:  # a stored hash never makes us do unbounded work
            return False
        expected = base64.b64decode(digest)
        with _HASHING:
            actual = hashlib.scrypt(
                password.encode(),
                salt=base64.b64decode(salt),
                n=n,
                r=r,
                p=p,
                maxmem=MAXMEM * 2,
                dklen=len(expected),
            )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def needs_rehash(stored: str) -> bool:
    """A hash made with weaker settings than today's."""
    try:
        _, n, r, p, *_ = stored.split("$")
        return int(n) * int(r) * int(p) < N * R * P
    except ValueError:
        return True


@cache
def dummy_hash() -> str:
    """Checked when an email has no account, so a wrong email takes as long as a wrong
    password and the login can't be used to find out who has an account."""
    return hash_password(secrets.token_urlsafe(16))


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    """What the database keeps of a session token: a copy of the database (a backup, a
    leak) can't be used to log in as anyone."""
    return hashlib.sha256(token.encode()).hexdigest()


def same_secret(given: str, expected: str) -> bool:
    """Compares a secret in constant time; an unset secret never matches."""
    return bool(expected) and hmac.compare_digest(
        hashlib.sha256(given.encode()).digest(), hashlib.sha256(expected.encode()).digest()
    )


class Throttle:
    """At most ``limit`` events (failed logins, sign-ups...) per key in ``window`` seconds.

    Kept in memory; keys with nothing recent are dropped once there are many, so a flood of
    made-up keys can't grow it without end."""

    MAX_KEYS = 20_000

    def __init__(self, limit: int = 8, window: float = 600):
        self.limit = limit
        self.window = window
        self.failures: dict[str, deque[float]] = {}

    def _recent(self, key: str) -> deque[float]:
        q = self.failures.get(key)
        if q is None:
            return deque()
        cutoff = time.monotonic() - self.window
        while q and q[0] < cutoff:
            q.popleft()
        if not q:
            del self.failures[key]
        return q

    def _prune(self) -> None:
        for key in list(self.failures):
            self._recent(key)
        while len(self.failures) >= self.MAX_KEYS:  # all recent: forget the oldest keys
            self.failures.pop(next(iter(self.failures)))

    def blocked(self, key: str) -> bool:
        return len(self._recent(key)) >= self.limit

    def fail(self, key: str) -> None:
        q = self._recent(key)
        if key not in self.failures:
            if len(self.failures) >= self.MAX_KEYS:
                self._prune()
            self.failures[key] = q
        q.append(time.monotonic())

    hit = fail  # for limits that count every event, not only failures

    def reset(self, key: str) -> None:
        self.failures.pop(key, None)
