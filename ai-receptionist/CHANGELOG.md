# Changelog

Newest first. Every entry: what changed, how to deploy, manual steps.

## M6 — Billing with Stripe

- **Added** `worker/src/billing.js` over plain fetch and Web Crypto (no Node SDK), pinned to Stripe API version
  `2026-08-26.dahlia` (`STRIPE_API_VERSION` overrides). `POST /admin/stripe/setup` creates a Product and monthly
  Price per plan, found again by `lookup_key` (idempotent).
- **Added** panel billing (owners only): Checkout in subscription mode with the remaining trial carried over,
  billing address and VAT number collected; Customer Portal for card, invoices and cancellation.
- **Added** `POST /webhooks/stripe`: signature verified, events stored and processed once, a failed run is
  forgotten so Stripe's retry is processed. Handles checkout.session.completed, customer.subscription.*,
  invoice.paid, invoice.payment_failed (owner told by SMS + Telegram) and invoice.created.
- **Overage**: on a renewal's draft invoice (`invoice.created`, `billing_reason = subscription_cycle`) one invoice
  item for the minutes over the plan in the period that just ended, from our `usage` table, recorded in
  `billing_overage` so it is never charged twice. Chosen over Billing Meters: no meter objects, no metered prices,
  no per-call reporting, and our usage table stays the source of truth.
- **Added** usage rule: a trial that ends without a paid subscription goes message-only after the same 3-day grace.
- **Fixed** panel routes with a query string (`#/account?checkout=success`) now open the right screen.
- **Assumptions**: field names follow the official stripe-node SDK for the pinned version (a Subscription's period
  is on its items; an Invoice reaches its subscription through `parent.subscription_details`). VAT: prices are
  ex-VAT unless `PRICES_INCLUDE_VAT = "true"`; automatic tax stays off until our VAT registration is decided
  (TODO, business decision).
- **Deploy**: `wrangler secret put STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (webhook endpoint with the 7 events
  listed in the README), `npm run db:init:remote` (migration 0006), `npm run deploy`, `POST /admin/stripe/setup`,
  enable the Customer Portal in the Stripe dashboard.

## M5 — Automatic agent provisioning

- **Added** `config/agent_template.json` (versioned) and `worker/src/provisioning.js`: idempotent `create` (an
  existing agent is synced, never duplicated; a lock stops concurrent creates), `sync` (skips when nothing changed),
  `attach-number` (existing Twilio number, or buy a local one; UK needs a Regulatory Bundle and says so),
  `pause`/`resume`, `delete`. Each business gets its own 6 webhook tools; their Authorization header comes from one
  ElevenLabs workspace secret. Admin API `POST /admin/b/:id/provision`, `POST /admin/provisioning/setup`;
  CLI `provisioning/cli.mjs` (calls the admin API, so secrets stay in the Worker).
- **Added** automatic sync: a panel settings save pushes the new prompt in the same request (no more "after the team
  syncs" banner once provisioning is configured); entering/leaving message-only mode pushes the paused prompt.
  Daily drift check (live agent vs what we render) reports to the team chat; agents of businesses cancelled longer
  than the retention period are deleted.
- **Changed** prompt rendering moved to `shared/prompt-core.mjs` (no file access) so the Worker renders the same
  prompt as `build_prompt.mjs`; the Worker bundles `prompts/*.md` as text. `PUT /admin/businesses` keeps the
  stored `agent_id` when the body has none.
- **Changed** QA uses the agent template's LLM by default (`claude-sonnet-5`): the earlier default
  (`claude-sonnet-5-5`) is not offered by ElevenLabs, so it was not "the same LLM".
- **Assumptions**: request shapes come from the official elevenlabs-js and twilio-node SDK sources (their docs sites
  were not reachable from the build environment); check them against the current API reference on first use. No
  temperature is sent for Claude 5 models (they reject non-default sampling). The post-call webhook is created once
  in the ElevenLabs dashboard and referenced by id. Deleting an agent keeps the Twilio number.
- **Deploy**: `wrangler secret put ELEVENLABS_API_KEY`; set `WORKER_PUBLIC_URL`, `ELEVENLABS_POST_CALL_WEBHOOK_ID`,
  `ELEVENLABS_VOICES` (and `TWILIO_BUNDLE_SID` + `TWILIO_ADDRESS_SID` to buy UK numbers); `npm run db:init:remote`
  (migration 0005); `npm run deploy`; `node provisioning/cli.mjs setup`.

## M4 — Usage metering and plan limits

- **Added** tables `plans` (seeded Basic/Pro, placeholder prices in data, minor units + currency), `subscriptions`,
  `usage` (one row per call, per-call round-up, estimated voice/LLM/telephony cost), `sms_usage` (segments),
  `usage_notices`; `businesses.message_only` + reason.
- **Added** rules on every post-call webhook and hourly: 80% and 100% notices to the owner (Telegram + SMS/email,
  once per period); message-only mode on a hard cap (owner setting in the panel), or after a 3-day grace when the
  subscription is past_due/paused (immediately when cancelled). In message-only mode the booking tools return
  `message_only` and the rendered prompt carries a "bookings paused" block.
- **Added** `GET /admin/usage?period=YYYY-MM` margin report and `PUT /admin/subscriptions` (until Stripe, M6).
  The panel shows plan, status and a usage bar, and a banner in message-only mode.
- **Changed** every SMS goes through `sendTrackedSms` (monitoring event + billed segments).
- **Assumptions**: `max_concurrent_calls` and `sms_included` values (1/100 Basic, 2/250 Pro) are placeholders and
  not enforced yet (concurrency is set on the ElevenLabs/Twilio side). The `multi` plan is not seeded until it is
  priced. The margin report uses calendar months; a trial earns no revenue; overage is charged only for
  active/past_due subscriptions. `COST_RATES` are placeholders to replace from real invoices.
- **Deploy**: `npm run db:init:remote` (migration 0004), `npm run deploy` (adds the hourly `7 * * * *` cron),
  then `PUT /admin/subscriptions` for each business.

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
