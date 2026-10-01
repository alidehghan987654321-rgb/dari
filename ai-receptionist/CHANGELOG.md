# Changelog

Newest first. Every entry: what changed, how to deploy, manual steps.

## M1 — Automated conversation QA

- **Added** `qa/`: `npm run qa` plays 23 scenarios from `prompts/test_scenarios.md` (`qa/scenarios.yaml`) against the
  rendered system prompt with the same LLM as the live agent, real tool calls to a local Worker + D1, and a deterministic
  judge. Writes `qa/report.md` / `report.json` with pass/fail per case, booking accuracy, invented-fact count and average
  turns per booking. `--mutate no-invent-guard` proves a broken prompt is caught; `--llm-judge` adds a separate style
  check; `--platform` (experimental) runs against the real ElevenLabs agent via its simulate-conversation API.
- **Added** GitHub Action `Receptionist QA` (manual trigger). CI runs the harness's own tests with a scripted agent.
- **Changed** `scripts/build_prompt.mjs` now uses the shared `scripts/prompt.mjs`. The opening-hours line says the
  profile's timezone instead of "UK time"; prices use the profile's `currency` (`price` or the older `price_gbp`).
  A `message_only` profile flag adds a "bookings paused" block (used by M4).
- **Dependencies** (QA only, never deployed): `@anthropic-ai/sdk` (official client for the model under test),
  `yaml` (scenario file format required by the M1 spec).
- **Manual step**: add the repository secret `ANTHROPIC_API_KEY` to run QA from GitHub Actions.

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
