# M4 — Usage metering and plan limits

> Paste `00_master_context.md` first, then this.

## Goal

Know exactly how many minutes, calls and SMS each business uses per billing period, warn before limits, and protect our margin.

## Build

1. `plans` table: id (basic, pro, multi), monthly_price_gbp, included_minutes, overage_pence_per_min, max_concurrent_calls, sms_included.
   Seed: basic £79 / 300 min / 25p; pro £149 / 600 min / 20p (prices are placeholders, keep them in data, not code).
2. `subscriptions` table: business_id, plan_id, status (trial|active|past_due|paused|cancelled), period_start, period_end, trial_end.
3. `usage` table, one row per call from the post-call webhook: business_id, conversation_id, seconds, billed_minutes (round up per call), cost estimate fields (voice, llm, telephony) for our own margin report. Also count SMS segments (Persian = UCS-2, 70 chars / 67 per part).
4. Rules (cron hourly + on each post-call):
   - 80% of included minutes → Telegram + SMS/email to owner (once per period).
   - 100% → notify owner; keep answering (overage billed) unless the business set `hard_cap: true`, then switch the agent to "message-only mode" (agent still answers but only takes messages; implement as a profile flag the prompt respects).
   - `past_due` or `paused` subscription → message-only mode after a 3-day grace period.
5. `GET /admin/usage?period=YYYY-MM` margin report: per business revenue vs estimated cost.
6. Panel (M3) shows a usage bar.

## Acceptance

- Replaying 50 fake post-call webhooks updates usage correctly, with per-call rounding.
- Threshold notifications fire once per period; tests for the pure rule function.
- Margin report matches a hand-calculated example.
