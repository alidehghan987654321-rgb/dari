-- M4: usage metering and plan limits. Money is stored in minor units (pence) with a currency.

CREATE TABLE IF NOT EXISTS plans (
  id                   TEXT PRIMARY KEY,          -- basic | pro | multi
  name                 TEXT NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'GBP',
  monthly_price        INTEGER NOT NULL,          -- minor units, ex-VAT
  included_minutes     INTEGER NOT NULL,
  overage_per_min      INTEGER NOT NULL,          -- minor units per billed minute over the included ones
  max_concurrent_calls INTEGER NOT NULL,
  sms_included         INTEGER NOT NULL,          -- SMS segments per period
  active               INTEGER NOT NULL DEFAULT 1
);
-- Placeholder prices (from the product plan); change them here or with SQL, never in code.
-- 'multi' (several branches) is priced when multi-branch exists (M9e).
INSERT OR IGNORE INTO plans (id, name, currency, monthly_price, included_minutes, overage_per_min, max_concurrent_calls, sms_included)
VALUES ('basic', 'Basic', 'GBP', 7900, 300, 25, 1, 100),
       ('pro',   'Pro',   'GBP', 14900, 600, 20, 2, 250);

CREATE TABLE IF NOT EXISTS subscriptions (
  business_id       TEXT PRIMARY KEY REFERENCES businesses(id),
  plan_id           TEXT NOT NULL REFERENCES plans(id),
  status            TEXT NOT NULL CHECK (status IN ('trial', 'active', 'past_due', 'paused', 'cancelled')),
  period_start      TEXT NOT NULL,                -- YYYY-MM-DD (inclusive)
  period_end        TEXT NOT NULL,                -- YYYY-MM-DD (exclusive)
  trial_end         TEXT,
  status_changed_at TEXT NOT NULL,                -- ISO UTC; starts the 3-day grace for past_due/paused
  updated_at        TEXT
);

-- One row per call, from the post-call webhook. Idempotent on conversation_id.
CREATE TABLE IF NOT EXISTS usage (
  conversation_id TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id),
  created_at      TEXT NOT NULL,                  -- ISO UTC
  seconds         INTEGER NOT NULL,
  billed_minutes  INTEGER NOT NULL,               -- rounded up per call
  cost_voice      REAL NOT NULL,                  -- our estimated costs, minor units (margin report only)
  cost_llm        REAL NOT NULL,
  cost_telephony  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_biz ON usage (business_id, created_at);

-- SMS we sent, in billed segments (Persian = UCS-2: 70 chars, 67 per part).
CREATE TABLE IF NOT EXISTS sms_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  segments    INTEGER NOT NULL,
  purpose     TEXT NOT NULL                       -- booking | cancel | login | usage_notice
);
CREATE INDEX IF NOT EXISTS idx_sms_usage_biz ON sms_usage (business_id, created_at);

-- Threshold notices already sent, so each fires once per period.
CREATE TABLE IF NOT EXISTS usage_notices (
  business_id  TEXT NOT NULL,
  period_start TEXT NOT NULL,
  kind         TEXT NOT NULL,                     -- '80' | '100'
  sent_at      TEXT NOT NULL,
  PRIMARY KEY (business_id, period_start, kind)
);

-- Message-only mode: the agent still answers but only takes messages. Set by the usage rules.
ALTER TABLE businesses ADD COLUMN message_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN message_only_reason TEXT;
