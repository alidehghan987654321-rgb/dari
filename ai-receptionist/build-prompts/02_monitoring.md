# M2 — Monitoring and alerting

> Paste `00_master_context.md` first, then this.

## Goal

The team knows within 5 minutes when a customer's receptionist is broken (Worker errors, slow tools, failed SMS, agent not answering), before the business owner notices.

## Build

1. **Structured logs** in the Worker: one JSON line per tool call `{ts, business_id, tool, ok, error, ms}`. No names, phone numbers or message text in logs (mask phones to last 3 digits).
2. **Metrics table** in D1 `tool_events` (same fields, 30-day retention via the existing cron) so the panel and alerts can query it.
3. **Alert rules** evaluated by a cron every 5 minutes:
   - error rate of any tool > 20% over the last 15 minutes with ≥ 5 calls
   - p95 tool latency > 2500 ms over 15 minutes
   - SMS or Telegram send failures ≥ 3 in 15 minutes
   - a business with ≥ 5 calls/day average and zero calls in the last 24 h during opening hours (forwarding probably broken)
   Alerts go to the **team** Telegram chat (`TEAM_ALERT_CHAT_ID`), deduplicated (same alert at most once per hour), with a "resolved" message when it clears.
4. **Daily synthetic check**: a cron that calls `/availability` and a dry-run booking (`dry_run: true` flag, add it: validates and returns without writing) for every active business, and alerts on failure.
5. `GET /admin/health` returns the last 24 h summary per business (calls, tool error rate, p95 latency, SMS failures).
6. Optional: forward Worker logs to Cloudflare Logpush or Workers Analytics Engine if available on our plan (check current docs); keep D1 as the source for alerts.

## Acceptance

- Killing the D1 binding locally triggers an error-rate alert in the test script within one cron run.
- Alerts are not repeated more than once per hour per rule and business.
- Unit tests for the alert rule evaluator (pure function: events in → alerts out).
