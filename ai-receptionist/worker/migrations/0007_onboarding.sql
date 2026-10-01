-- M8: landing page, self-serve sign-up, onboarding wizard and the sales funnel.

ALTER TABLE businesses ADD COLUMN onboarded_at TEXT;        -- wizard finished
ALTER TABLE businesses ADD COLUMN signup_source TEXT;       -- 'self_serve' | NULL (created by the team)

-- Funnel counters per day; no cookies, no third-party analytics.
CREATE TABLE IF NOT EXISTS funnel_counts (
  day   TEXT NOT NULL,                                       -- YYYY-MM-DD UTC
  event TEXT NOT NULL,                                       -- visit | demo_call | signup | wizard_done | preview_call | forwarding_on | paid
  count INTEGER NOT NULL,
  PRIMARY KEY (day, event)
);

-- Business-level funnel steps count once per business.
CREATE TABLE IF NOT EXISTS funnel_marks (
  business_id TEXT NOT NULL,
  event       TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (business_id, event)
);
