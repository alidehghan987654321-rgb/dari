-- M2: monitoring and alerting.

-- One row per tool call and per outbound notification. No personal data. Purged after 30 days by the daily cron.
CREATE TABLE IF NOT EXISTS tool_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,                 -- ISO 8601 UTC
  business_id TEXT NOT NULL,
  tool        TEXT NOT NULL,                 -- availability | book | ... | sms | telegram
  ok          INTEGER NOT NULL,              -- 1 / 0
  error       TEXT,                          -- error code, never free text
  ms          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_events_ts  ON tool_events (ts);
CREATE INDEX IF NOT EXISTS idx_tool_events_biz ON tool_events (business_id, ts);

-- Alert deduplication: one row per alert key (rule + business [+ tool]).
CREATE TABLE IF NOT EXISTS alert_state (
  key          TEXT PRIMARY KEY,
  rule         TEXT NOT NULL,
  business_id  TEXT,
  active       INTEGER NOT NULL,
  text         TEXT,
  first_at     TEXT NOT NULL,
  last_sent_at TEXT NOT NULL,
  resolved_at  TEXT
);

-- Latest daily synthetic check per business.
CREATE TABLE IF NOT EXISTS synthetic_checks (
  business_id TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  error       TEXT
);

-- Inactive businesses (paused, cancelled, test) are skipped by the synthetic check and the silence alert.
ALTER TABLE businesses ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
