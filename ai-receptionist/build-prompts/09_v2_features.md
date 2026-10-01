# M9 — Version 2 features (after the first paying customers)

> Paste `00_master_context.md` first, then ONE of the sections below per task. Build only what pilots asked for.

## 9a. Appointment reminders (outbound)

- Day-before SMS reminder with "reply C to cancel"; handle inbound SMS replies via a Twilio webhook (cancel → frees the slot, notifies owner).
- Optional outbound reminder call by the agent for no-show-prone businesses (check current ElevenLabs outbound calling API; respect UK calling hours 9:00–20:00 and opt-out).

## 9b. Missed-call text-back and review requests

- If a call drops before the agent answers or the caller hangs up early, send "Sorry we missed you, book here: <link>" (rate-limited per number).
- After a completed appointment, optional SMS asking for a Google review (link from profile), max once per customer per 90 days.

## 9c. WhatsApp and Telegram chat with the same brain

- Reuse the same system prompt (text variant) and the same tools to answer WhatsApp Business (Twilio or Meta Cloud API; check current docs) and Telegram messages.

## 9d. Phone food ordering (restaurants/takeaways)

- Menu in profile (items, options, prices, availability), `create_order` tool, order ticket to the owner's Telegram and optional printer integration; reuse NightOrder ideas where they fit. Payment stays in the shop (no card details on the call).

## 9e. Multi-branch and staff calendars

- Several locations under one account; staff-specific services and calendars; "with Ali please" preference.

## Acceptance (each)

- Feature flag per business, off by default; tests for the new tool/route; prompt section added and covered by a QA case (M1).
