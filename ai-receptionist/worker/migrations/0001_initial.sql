-- D1 schema for the AI receptionist backend.
-- Applied with: npx wrangler d1 migrations apply receptionist --local / --remote

CREATE TABLE IF NOT EXISTS businesses (
  id            TEXT PRIMARY KEY,          -- slug, e.g. 'pars-barbers-acton'
  agent_id      TEXT UNIQUE,               -- ElevenLabs agent id (for the post-call webhook)
  profile_json  TEXT NOT NULL,             -- full business profile (see prompts/business_profile.example.json)
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT PRIMARY KEY,         -- short readable code, e.g. 'K7QX2M'
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  service_id     TEXT NOT NULL,
  date           TEXT NOT NULL,            -- YYYY-MM-DD, business local (UK) date
  start_min      INTEGER NOT NULL,         -- minutes since local midnight
  end_min        INTEGER NOT NULL,
  customer_name  TEXT NOT NULL,
  customer_phone TEXT NOT NULL,            -- E.164
  language       TEXT NOT NULL DEFAULT 'en',
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | cancelled
  source         TEXT NOT NULL DEFAULT 'phone_ai',
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_day   ON bookings (business_id, date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings (business_id, customer_phone, status);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  caller_name   TEXT,
  caller_phone  TEXT,
  message       TEXT,
  urgency       TEXT NOT NULL DEFAULT 'normal',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  conversation_id TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id),
  agent_id        TEXT,
  caller          TEXT,
  duration_secs   INTEGER,
  summary         TEXT,
  success         TEXT,
  data_json       TEXT,
  transcript_json TEXT,                    -- nulled after RETENTION_DAYS by the daily cron
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_biz ON calls (business_id, created_at);
