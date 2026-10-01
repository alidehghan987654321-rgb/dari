-- M6: billing with Stripe.

ALTER TABLE plans ADD COLUMN stripe_price_id TEXT;               -- set by POST /admin/stripe/setup (lookup_key receptionist_<plan>)

ALTER TABLE subscriptions ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE subscriptions ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON subscriptions (stripe_subscription_id);

-- Every Stripe event we processed (replays are ignored).
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Overage charged per business and usage period, so it is never invoiced twice.
CREATE TABLE IF NOT EXISTS billing_overage (
  business_id     TEXT NOT NULL,
  period_start    TEXT NOT NULL,                -- ISO UTC
  period_end      TEXT NOT NULL,
  minutes         INTEGER NOT NULL,             -- billed minutes over the plan
  amount          INTEGER NOT NULL,             -- minor units
  stripe_invoice  TEXT,
  stripe_item     TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (business_id, period_start)
);
