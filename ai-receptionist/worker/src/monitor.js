// M2 — monitoring and alerting.
// Pure parts (rule evaluation, dedupe planning, percentiles, opening-time maths) are exported for unit tests;
// the I/O parts read and write D1 and post to the team Telegram chat.

import { londonNow, parseHHMM, addDays, weekdayOf } from './lib.js';
import { sendTeamAlert } from './notify.js';

export const WINDOW_MIN = 15;
export const REPEAT_MIN = 60;
export const NOTIFY_TOOLS = new Set(['sms', 'telegram']);

// Errors that mean the system is broken. Business outcomes (slot_taken, closed, bad_phone, not_found...)
// are normal answers to the caller and never count toward the error rate.
export const SYSTEM_ERRORS = new Set([
  'server_error', 'external_error', 'not_configured', 'unknown_business', 'unknown_tool', 'db_error', 'send_failed',
]);

export const isFailure = e => !e.ok && (NOTIFY_TOOLS.has(e.tool) || SYSTEM_ERRORS.has(e.error));

export function maskPhone(s) {
  const digits = String(s || '').replace(/\D/g, '');
  return digits.length <= 3 ? '***' : `${'*'.repeat(digits.length - 3)}${digits.slice(-3)}`;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Minutes the business was open during the `hours` before `now` (default 24 h), in its own timezone. */
export function openMinutesInWindow(profile, now = new Date(), hours = 24) {
  const tz = profile.timezone || 'Europe/London';
  const local = londonNow(now, tz);
  let remaining = hours * 60;
  let date = local.date;
  let end = local.minutes; // window covers [end - remaining, end] on `date`, then continues on earlier days
  let open = 0;
  while (remaining > 0) {
    const start = Math.max(0, end - remaining);
    if (!(profile.closed_dates || []).includes(date)) {
      for (const [o, c] of (profile.opening_hours || {})[weekdayOf(date)] || []) {
        open += Math.max(0, Math.min(end, parseHHMM(c)) - Math.max(start, parseHHMM(o)));
      }
    }
    remaining -= end - start;
    date = addDays(date, -1);
    end = 1440;
  }
  return open;
}

/**
 * Rules -> currently active alerts. Pure.
 * events:      tool_events of the last WINDOW_MIN minutes [{ business_id, tool, ok, error, ms }]
 * callStats:   [{ business_id, avg_per_day, calls_24h, open_minutes_24h }]
 * synthetic:   latest synthetic check per business [{ business_id, ok, error, ts }]
 * dbDown:      the database probe failed
 */
export function evaluateAlerts({ events = [], callStats = [], synthetic = [], dbDown = false }) {
  const alerts = [];
  if (dbDown) alerts.push({ key: 'database', rule: 'database', business_id: null, text: 'Database (D1) is not answering. Every tool call is failing.' });

  const byKey = new Map();
  const add = (k, e) => (byKey.get(k) || byKey.set(k, []).get(k)).push(e);
  for (const e of events) {
    if (NOTIFY_TOOLS.has(e.tool)) add(`notify|${e.business_id}`, e);
    else {
      add(`tool|${e.business_id}|${e.tool}`, e);
      add(`latency|${e.business_id}`, e);
    }
  }

  for (const [k, list] of byKey) {
    const [kind, biz, tool] = k.split('|');
    if (kind === 'tool' && list.length >= 5) {
      const failed = list.filter(isFailure).length;
      if (failed / list.length > 0.2) {
        alerts.push({ key: `error_rate:${biz}:${tool}`, rule: 'error_rate', business_id: biz,
          text: `${biz}: ${tool} failing — ${failed}/${list.length} calls (${Math.round(100 * failed / list.length)}%) in the last ${WINDOW_MIN} min.` });
      }
    }
    if (kind === 'latency' && list.length >= 5) {
      const p95 = percentile(list.map(e => e.ms), 95);
      if (p95 > 2500) {
        alerts.push({ key: `latency:${biz}`, rule: 'latency', business_id: biz, text: `${biz}: tools are slow — p95 ${p95} ms over ${list.length} calls in the last ${WINDOW_MIN} min.` });
      }
    }
    if (kind === 'notify') {
      const failed = list.filter(e => !e.ok);
      if (failed.length >= 3) {
        const which = [...new Set(failed.map(e => e.tool))].join(' + ');
        alerts.push({ key: `notify:${biz}`, rule: 'notify', business_id: biz, text: `${biz}: ${failed.length} ${which} sends failed in the last ${WINDOW_MIN} min.` });
      }
    }
  }

  for (const s of callStats) {
    if (s.avg_per_day >= 5 && s.calls_24h === 0 && s.open_minutes_24h >= 240) {
      alerts.push({ key: `silent:${s.business_id}`, rule: 'silent', business_id: s.business_id,
        text: `${s.business_id}: no calls in 24 h (usually ${s.avg_per_day.toFixed(1)}/day, open ${Math.round(s.open_minutes_24h / 60)} h). Call forwarding may be broken.` });
    }
  }

  for (const s of synthetic) {
    if (!s.ok) alerts.push({ key: `synthetic:${s.business_id}`, rule: 'synthetic', business_id: s.business_id, text: `${s.business_id}: daily self-test failed (${s.error}).` });
  }
  return alerts;
}

/**
 * Dedupe. Pure. active: alerts from evaluateAlerts; state: alert_state rows. Returns what to send and
 * how to update the state: a new alert fires now; a still-active one is repeated at most once per
 * REPEAT_MIN; a previously active one that is gone gets a "resolved" message.
 */
export function planAlerts(active, state, now = new Date()) {
  const nowIso = now.toISOString();
  const rows = new Map(state.map(r => [r.key, r]));
  const send = [];
  const upsert = [];
  for (const a of active) {
    const prev = rows.get(a.key);
    if (!prev || !prev.active) {
      send.push({ key: a.key, text: `🔴 ${a.text}` });
      upsert.push({ ...a, active: 1, first_at: nowIso, last_sent_at: nowIso, resolved_at: null });
    } else if (now - new Date(prev.last_sent_at) >= REPEAT_MIN * 60_000) {
      send.push({ key: a.key, text: `🔴 Still failing: ${a.text}` });
      upsert.push({ ...a, active: 1, first_at: prev.first_at, last_sent_at: nowIso, resolved_at: null });
    }
  }
  const activeKeys = new Set(active.map(a => a.key));
  for (const r of state) {
    if (r.active && !activeKeys.has(r.key)) {
      send.push({ key: r.key, text: `✅ Resolved: ${r.text}` });
      upsert.push({ ...r, active: 0, resolved_at: nowIso });
    }
  }
  return { send, upsert };
}

// ---------------- I/O ----------------

// If D1 itself is down, events and alert state are kept in this isolate (best effort) so the outage still
// produces an error-rate alert and is not re-sent every 5 minutes.
const memEvents = [];
const memState = new Map();

export function logToolEvent(evt) {
  console.log(JSON.stringify({ evt: 'tool', ...evt }));
}

export async function recordEvent(env, evt) {
  try {
    await env.DB.prepare('INSERT INTO tool_events (ts, business_id, tool, ok, error, ms) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(evt.ts, evt.business_id, evt.tool, evt.ok ? 1 : 0, evt.error || null, evt.ms).run();
  } catch (e) {
    memEvents.push(evt);
    if (memEvents.length > 1000) memEvents.splice(0, memEvents.length - 1000);
  }
}

/** Wrap an outbound notification so its outcome is logged and recorded. `send` returns true/false/null. */
export async function trackedNotify(env, businessId, channel, send) {
  const t = Date.now();
  const ok = await send();
  if (ok === null) return null; // channel not configured: nothing attempted
  const evt = { ts: new Date().toISOString(), business_id: businessId, tool: channel, ok, error: ok ? null : 'send_failed', ms: Date.now() - t };
  logToolEvent(evt);
  await recordEvent(env, evt);
  return ok;
}

async function dbAlive(env) {
  try { await env.DB.prepare('SELECT 1 FROM tool_events LIMIT 1').all(); return true; } catch { return false; }
}

async function recentEvents(env, sinceIso, dbUp) {
  const mem = memEvents.filter(e => e.ts >= sinceIso);
  if (!dbUp) return mem;
  const r = await env.DB.prepare('SELECT business_id, tool, ok, error, ms FROM tool_events WHERE ts >= ?').bind(sinceIso).all();
  return [...(r.results || []).map(e => ({ ...e, ok: !!e.ok })), ...mem];
}

async function activeBusinesses(env) {
  const r = await env.DB.prepare('SELECT id, profile_json FROM businesses WHERE active = 1').all();
  return (r.results || []).map(b => ({ id: b.id, profile: JSON.parse(b.profile_json) }));
}

async function callStats(env, businesses, now) {
  const r = await env.DB.prepare(
    `SELECT business_id,
            SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS calls_24h,
            SUM(CASE WHEN created_at <  datetime('now', '-1 day') AND created_at >= datetime('now', '-15 days') THEN 1 ELSE 0 END) AS calls_prev14
       FROM calls WHERE created_at >= datetime('now', '-15 days') GROUP BY business_id`
  ).all();
  const byBiz = new Map((r.results || []).map(x => [x.business_id, x]));
  return businesses.map(b => {
    const x = byBiz.get(b.id) || { calls_24h: 0, calls_prev14: 0 };
    return { business_id: b.id, calls_24h: x.calls_24h, avg_per_day: x.calls_prev14 / 14, open_minutes_24h: openMinutesInWindow(b.profile, now) };
  });
}

/** 5-minute cron: evaluate rules, dedupe, notify the team chat. */
export async function runAlerts(env, now = new Date()) {
  const dbUp = await dbAlive(env);
  const since = new Date(now - WINDOW_MIN * 60_000).toISOString();
  const events = await recentEvents(env, since, dbUp);
  let stats = [], synthetic = [];
  if (dbUp) {
    stats = await callStats(env, await activeBusinesses(env), now);
    const s = await env.DB.prepare(
      `SELECT s.business_id, s.ok, s.error, s.ts FROM synthetic_checks s JOIN businesses b ON b.id = s.business_id WHERE b.active = 1`
    ).all();
    synthetic = (s.results || []).map(x => ({ ...x, ok: !!x.ok }));
  }
  const active = evaluateAlerts({ events, callStats: stats, synthetic, dbDown: !dbUp });

  const state = dbUp
    ? ((await env.DB.prepare('SELECT * FROM alert_state').all()).results || [])
    : [...memState.values()];
  if (dbUp) for (const r of memState.values()) if (!state.some(s => s.key === r.key)) state.push(r);
  const plan = planAlerts(active, state, now);

  for (const m of plan.send) await sendTeamAlert(env, m.text);
  for (const u of plan.upsert) {
    memState.set(u.key, u);
    if (dbUp) {
      await env.DB.prepare(
        `INSERT INTO alert_state (key, rule, business_id, active, text, first_at, last_sent_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET active = excluded.active, text = excluded.text, first_at = excluded.first_at,
           last_sent_at = excluded.last_sent_at, resolved_at = excluded.resolved_at`
      ).bind(u.key, u.rule, u.business_id ?? null, u.active, u.text, u.first_at, u.last_sent_at, u.resolved_at ?? null).run();
    }
  }
  if (dbUp) memEvents.length = 0; // flushed into the evaluation; D1 is the source again
  return { active, sent: plan.send.length };
}

/** First open date from tomorrow on (up to 14 days), in the business's timezone. */
function nextOpenDate(profile, now) {
  const today = londonNow(now, profile.timezone).date;
  for (let i = 1; i <= 14; i++) {
    const d = addDays(today, i);
    if (!(profile.closed_dates || []).includes(d) && ((profile.opening_hours || {})[weekdayOf(d)] || []).length) return d;
  }
  return null;
}

/**
 * Daily synthetic check: availability + a dry-run booking for every active business, through the same
 * tool function the agent uses. `runTool(name, business, body)` returns the tool's result object.
 */
export async function runSynthetic(env, runTool, now = new Date()) {
  const results = [];
  for (const b of await activeBusinesses(env)) {
    let ok = true, error = null;
    try {
      const service = (b.profile.services || [])[0];
      const date = nextOpenDate(b.profile, now);
      if (!service) [ok, error] = [false, 'no_services'];
      else if (!date) [ok, error] = [false, 'no_open_days'];
      else {
        const avail = await runTool('availability', b, { service_id: service.id, date });
        if (!avail.ok) [ok, error] = [false, `availability:${avail.error}`];
        else if (avail.slots.length) {
          const dry = await runTool('book', b, {
            service_id: service.id, date, time: avail.slots[0], customer_name: 'Synthetic check',
            customer_phone: '+447700900000', language: 'en', dry_run: true,
          });
          if (!dry.ok) [ok, error] = [false, `book:${dry.error}`];
        }
      }
    } catch (e) {
      [ok, error] = [false, 'exception'];
      console.error(JSON.stringify({ evt: 'synthetic_exception', business_id: b.id, error: String(e?.message || e) }));
    }
    await env.DB.prepare(
      `INSERT INTO synthetic_checks (business_id, ts, ok, error) VALUES (?, ?, ?, ?)
       ON CONFLICT(business_id) DO UPDATE SET ts = excluded.ts, ok = excluded.ok, error = excluded.error`
    ).bind(b.id, now.toISOString(), ok ? 1 : 0, error).run();
    results.push({ business_id: b.id, ok, error });
  }
  return results;
}

/** GET /admin/health: last 24 h per business. */
export async function healthSummary(env, now = new Date()) {
  const since = new Date(now - 24 * 3600_000).toISOString();
  const [biz, events, calls, synth] = await Promise.all([
    env.DB.prepare('SELECT id, active FROM businesses ORDER BY id').all(),
    env.DB.prepare('SELECT business_id, tool, ok, error, ms FROM tool_events WHERE ts >= ?').bind(since).all(),
    env.DB.prepare("SELECT business_id, COUNT(*) AS n FROM calls WHERE created_at >= datetime('now', '-1 day') GROUP BY business_id").all(),
    env.DB.prepare('SELECT business_id, ok, error, ts FROM synthetic_checks').all(),
  ]);
  const callsBy = new Map((calls.results || []).map(c => [c.business_id, c.n]));
  const synthBy = new Map((synth.results || []).map(s => [s.business_id, s]));
  return (biz.results || []).map(b => {
    const ev = (events.results || []).filter(e => e.business_id === b.id).map(e => ({ ...e, ok: !!e.ok }));
    const tools = ev.filter(e => !NOTIFY_TOOLS.has(e.tool));
    const s = synthBy.get(b.id);
    return {
      business_id: b.id,
      active: !!b.active,
      calls_24h: callsBy.get(b.id) || 0,
      tool_calls_24h: tools.length,
      tool_error_rate: tools.length ? Math.round(1000 * tools.filter(isFailure).length / tools.length) / 1000 : null,
      p95_ms: percentile(tools.map(e => e.ms), 95),
      sms_failures_24h: ev.filter(e => e.tool === 'sms' && !e.ok).length,
      telegram_failures_24h: ev.filter(e => e.tool === 'telegram' && !e.ok).length,
      synthetic: s ? { ok: !!s.ok, error: s.error, ts: s.ts } : null,
    };
  });
}
