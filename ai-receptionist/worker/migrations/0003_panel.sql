-- M3: owner panel — accounts, one-time login codes, sessions, rate limits.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   TEXT REFERENCES businesses(id),   -- NULL for superadmin (our team)
  name          TEXT NOT NULL,
  phone         TEXT,                             -- E.164; login by SMS code
  email         TEXT,                             -- lowercase; login by email code
  role          TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'superadmin')),
  prefs_json    TEXT NOT NULL DEFAULT '{}',       -- { lang: 'fa'|'en', digits: 'fa'|'latn' }
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users (phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_business ON users (business_id);

-- Codes and session tokens are stored only as HMACs (SESSION_SECRET), never in clear.
CREATE TABLE IF NOT EXISTS login_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,                       -- ISO UTC, 10 minutes
  attempts   INTEGER NOT NULL DEFAULT 0,          -- dead after 5 wrong tries
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_codes_user ON login_codes (user_id, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL                        -- ISO UTC, 30 days
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- Fixed-window counters, e.g. 'code:id:+447700900123', 'code:ip:203.0.113.5'.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,                  -- unix seconds
  count        INTEGER NOT NULL
);

-- Owner edited the profile in the panel: the live agent prompt must be re-rendered (M5 does it automatically).
ALTER TABLE businesses ADD COLUMN needs_sync INTEGER NOT NULL DEFAULT 0;
-- Messages handled by the owner.
ALTER TABLE messages ADD COLUMN done_at TEXT;
