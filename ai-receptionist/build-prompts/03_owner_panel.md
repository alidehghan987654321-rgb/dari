# M3 — Business owner panel

> Paste `00_master_context.md` first, then this.

## Goal

A simple, Persian-first mobile web panel where the owner sees what the receptionist did and keeps their business info current without calling us. Needed for the pilot (Phase 3).

## Users and login

- One or more owner/staff accounts per business (`users` table: id, business_id, name, phone, email, role: owner|staff).
- Login with a **one-time code by SMS or email** (6 digits, 10-minute expiry, max 5 tries) → session cookie (HttpOnly, Secure, SameSite=Lax, 30 days). No passwords.
- Our team has a `superadmin` role that can switch between businesses.

## Screens (Persian RTL, English toggle, Vazirmatn, works well at 360 px width)

1. **امروز (Today)**: today's bookings in time order (name, service, time, phone tap-to-call, status), calls today, unread messages, minutes used this month vs plan.
2. **نوبت‌ها (Bookings)**: day/week view, add a booking manually (walk-in or phone), cancel, move. Uses the same Worker logic as the agent (reuse `computeSlots`; no duplicate booking logic).
3. **تماس‌ها (Calls)**: list with caller, time, duration, language, outcome, summary; tap to see the transcript (until retention deletes it) and play the recording if ElevenLabs provides a recording URL (check current docs).
4. **پیام‌ها (Messages)**: messages taken by the agent, mark done, tap-to-call back.
5. **تنظیمات کسب‌وکار (Business settings)**: opening hours, closed dates, services (name fa/en, duration, price), capacity, policies, FAQ, transfer number and hours. Saving updates `profile_json` and marks the agent prompt as "needs sync" (M5 provisioning re-renders and pushes the prompt; until M5 exists, show a banner "changes go live after the team syncs").
6. **حساب (Account)**: plan, invoices link (Stripe portal from M6), users.

## Tech

- Front end: Cloudflare Pages, vanilla JS or Preact + HTM (no build step preferred), one small CSS file with design tokens and dark mode.
- API: new routes in the existing Worker under `/api/*` with session auth; strict business scoping on every query (a user can only read their own business_id). Add tests that prove cross-business access is denied.
- Rate-limit login code requests (per phone/email and per IP).

## Acceptance

- Owner can log in on a phone, see today's bookings, add a walk-in booking that the AI then respects (slot no longer offered), edit opening hours, and read yesterday's call summary.
- All API routes have authz tests; Lighthouse mobile accessibility ≥ 90.
- Persian numbers and dates display correctly (Persian digits optional per user setting).
