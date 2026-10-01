# Changelog

Newest first. Every entry: what changed, how to deploy, manual steps.

## Database migrations and integration tests

- **Changed**: `worker/schema.sql` is now `worker/migrations/0001_initial.sql`. New tables come as numbered migration files.
  `npm run db:init:local` / `db:init:remote` run `wrangler d1 migrations apply`.
- **Added**: `npm run test:integration` starts the Worker with `wrangler dev`, a fresh local D1 and a mock for
  Telegram/Twilio, and tests the six tools, capacity under concurrent bookings, and the post-call webhook.
  GitHub Action `Receptionist tests` runs unit + integration tests on every push that touches `ai-receptionist/`.
- **Changed**: `notify.js` senders return `null` when a channel is not configured (so it is not counted as a
  failure) and no longer log provider response bodies (they can contain phone numbers).
  New optional vars `TELEGRAM_API_BASE`, `TWILIO_API_BASE` (tests only; leave unset in production).
- **Deploy**: if the database was created with the old `schema.sql`, run `npm run db:init:remote` once: the first
  migration only uses `CREATE ... IF NOT EXISTS`, so it is safe on an existing database.
