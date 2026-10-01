# MASTER CONTEXT — paste this at the top of every build prompt

You are a senior full-stack engineer joining a small team that is building **an AI phone receptionist for Iranian-owned small businesses in the UK** (barbers, salons, restaurants, clinics). Read this whole context before writing code.

## Product in one paragraph

A caller rings the business's UK number. An ElevenLabs voice agent answers in Persian or English (it detects the caller's language), answers questions from the business profile, checks free slots, books, reschedules or cancels appointments, takes messages, and transfers to the owner when needed. The owner gets a Telegram summary of every call and an SMS confirmation goes to the customer. We sell it as a monthly subscription (plans with included minutes).

## What already exists (do not rewrite unless the task says so)

Repository layout:

```
prompts/   system_prompt.template.md, first_message.md, business_profile.example.json, test_scenarios.md
config/    tools.json (6 webhook tools), agent_settings.md
scripts/   build_prompt.mjs (renders the system prompt from a business profile)
worker/    Cloudflare Worker + D1 (JavaScript, ES modules, no framework)
  src/index.js   routes: POST /b/:businessId/{availability|book|find-bookings|reschedule|cancel|message}
                 POST /webhooks/post-call (ElevenLabs HMAC), /admin/* (Bearer ADMIN_SECRET), daily cron retention
  src/lib.js     pure helpers: Europe/London time, slot computation with capacity, UK phone normalisation
                 (incl. Persian digits), readable booking ids, HMAC verify, Persian/English SMS text
  src/notify.js  Telegram + Twilio SMS (never throw)
  schema.sql     tables: businesses(id, agent_id, profile_json), bookings, messages, calls
  test/          node --test unit tests (14 passing)
docs/      onboarding_checklist.md, compliance_pack.md, sales_script.md
```

## Stack and conventions (follow them)

- Runtime: **Cloudflare Workers** (JavaScript ES modules) + **D1** (SQLite). Static front ends on **Cloudflare Pages**. No Node-only APIs in Worker code.
- Keep dependencies minimal. Prefer the platform (fetch, crypto.subtle, Intl). Any new dependency needs a one-line justification in the PR.
- Secrets only through `wrangler secret put`; never in code, never in git.
- All times stored as UK local date `YYYY-MM-DD` + minutes since midnight, timezone `Europe/London`. Reuse `lib.js` helpers.
- Phone numbers stored as E.164. Reuse `normalizePhone`.
- Tool endpoints always return HTTP 200 with `{ ok: true, ... }` or `{ ok: false, error, message_for_agent }`.
- UI text: **Persian first (RTL)** with an English toggle. Font: Vazirmatn (Google Fonts). Mobile-first: most owners use a phone.
- **Multi-country ready**: v1 sells in the UK only, but customers are Iranian-owned businesses outside Iran and we will add other countries later (e.g. Canada, Germany). Never hard-code UK: read `country`, `currency`, `timezone` and `languages` from the business profile; phone normalisation takes the profile country as default; prices and plans carry a currency. Persian + English are the two supported languages in v1.
- Privacy (UK GDPR): we are a data processor. Minimise personal data, never log full transcripts to console, respect `RETENTION_DAYS`.
- External platform APIs (ElevenLabs, Twilio, Stripe) change often. **Before calling any of them, read their current official docs and use the exact current endpoint and field names. Do not rely on memory.** Put each integration behind a small module so it can be swapped.

## Definition of done (every task)

1. Code + migrations + updated `README.md` section for the feature.
2. Unit tests for pure logic, and an integration test script (curl or node) that runs against `wrangler dev` with a local D1.
3. `npm test` passes; no secrets in the diff.
4. A short `CHANGELOG.md` entry: what changed, how to deploy, any manual step.
5. List any assumption you made at the top of your final message.
