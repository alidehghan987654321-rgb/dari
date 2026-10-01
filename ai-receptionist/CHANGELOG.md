# Changelog

Newest first. Every entry: what changed, how to deploy, manual steps.

## M3 — Business owner panel

- **Added** `web/panel/`: Persian-first (RTL) mobile web panel with an English toggle, Vazirmatn, light/dark,
  vanilla JS without a build step. Screens: Today, Bookings (day/week, walk-in, move, cancel), Calls (summary,
  transcript, recording), Messages, Business settings, Account (plan/usage, users, language, Persian digits).
  Lighthouse mobile accessibility: 100 on every screen. No horizontal scroll at 360 px.
- **Added** `/api/*` in the Worker (`panel.js`): passwordless login (6-digit code by SMS or email, 10-minute
  expiry, 5 tries, rate-limited per number/email and per IP) -> 30-day HttpOnly/Secure/SameSite=Lax session.
  Codes and session tokens are stored only as HMACs. Roles owner/staff/superadmin; every business-scoped
  query is filtered by the session's business (tests prove cross-business access is denied on every route).
  JSON-only writes (CSRF). Recordings are proxied so the ElevenLabs key never reaches the browser.
- **Changed** booking logic moved to `bookings.js`, shared by the agent tools and the panel (no duplicate rules).
  `computeSlots` takes an optional `minNoticeMinutes` (the panel uses 0 for walk-ins). Availability returns
  `price` + `currency` instead of `price_gbp`. `PUT /admin/users` creates the first owner or a superadmin.
- **Assumption**: the panel is served by the Worker itself (`[assets]` in `wrangler.toml`, Cloudflare's static
  assets on Workers) instead of a separate Pages project, so `/panel` and `/api` share one origin and the session
  cookie stays first-party (`*.workers.dev` and `*.pages.dev` are different sites).
- **Assumption**: one login per phone number/email (a person who owns two businesses needs two identifiers until
  multi-branch, M9e).
- **Deploy**: `wrangler secret put SESSION_SECRET`; optional `RESEND_API_KEY` + `EMAIL_FROM` (email login) and
  `ELEVENLABS_API_KEY` (recordings); `npm run db:init:remote` (migration 0003); `npm run deploy`; create the first
  owner with `PUT /admin/users`.

## M2 — Monitoring and alerting

- **Added** one JSON log line per tool call `{ts, business_id, tool, ok, error, ms}` (no names, numbers or message text)
  and the same events in D1 `tool_events` (30-day retention). SMS and Telegram sends are recorded too.
- **Added** alert rules every 5 minutes to the team Telegram chat (`TEAM_ALERT_CHAT_ID`): tool error rate, p95 latency,
  notification failures, silent business (forwarding probably broken), database down, failed daily self-test.
  Same alert at most once per hour per rule and business; a "Resolved" message when it clears. If D1 itself is down,
  events and dedupe state are kept in memory (best effort) so the outage is still reported.
- **Added** `dry_run: true` on `/book` (validates, writes nothing, sends nothing) and a daily synthetic check of every
  active business. `GET /admin/health`. `businesses.active` column (`"active": false` in `PUT /admin/businesses`).
- **Changed** tool handlers return plain objects; the router wraps them. Error logs no longer print stack traces
  that could carry request data.
- **Deploy**: `npm run db:init:remote` (migration 0002), set `TEAM_ALERT_CHAT_ID`, `npm run deploy`. The new
  `*/5 * * * *` cron and `[observability]` (Workers Logs) come with the deploy.

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
