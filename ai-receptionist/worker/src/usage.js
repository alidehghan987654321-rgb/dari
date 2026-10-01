// M4 — usage metering and plan limits.
// Pure parts (rounding, cost estimate, rules, margin report) are exported for unit tests; the rest reads and
// writes D1 and notifies owners.

import { smsSegments } from './lib.js';
import { sendTelegram, sendSms } from './notify.js';
import { sendEmail } from './email.js';
import { trackedNotify } from './monitor.js';

export const GRACE_DAYS = 3;
const DEFAULT_RATES = { voice_per_min: 0, llm_per_min: 0, telephony_per_min: 0, sms_per_segment: 0 };

export const billedMinutes = secs => Math.ceil(Math.max(0, Number(secs) || 0) / 60);

/** Our estimated cost of one call in minor units, from per-minute rates (exact seconds, not billed minutes). */
export function callCost(secs, rates) {
  const m = Math.max(0, Number(secs) || 0) / 60;
  return { voice: m * rates.voice_per_min, llm: m * rates.llm_per_min, telephony: m * rates.telephony_per_min };
}

export function costRates(env) {
  try { return { ...DEFAULT_RATES, ...JSON.parse(env.COST_RATES || '{}') }; } catch { return DEFAULT_RATES; }
}

/** Calendar month [start, end) in UTC for businesses without a subscription, as YYYY-MM-DD. */
export function calendarPeriod(now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const iso = d => d.toISOString().slice(0, 10);
  return { start: iso(new Date(Date.UTC(y, m, 1))), end: iso(new Date(Date.UTC(y, m + 1, 1))) };
}

/**
 * The rules. Pure.
 * plan: { included_minutes } | null; sub: { status, status_changed_at } | null
 * Returns { notify: ['80', '100'] (not yet sent this period), messageOnly, reason }.
 */
export function usageRules({ plan, sub, usedMinutes, hardCap = false, sent = [], now = new Date() }) {
  const notify = [];
  let messageOnly = false, reason = null;
  if (plan && plan.included_minutes > 0) {
    const ratio = usedMinutes / plan.included_minutes;
    if (ratio >= 0.8 && !sent.includes('80')) notify.push('80');
    if (ratio >= 1 && !sent.includes('100')) notify.push('100');
    if (hardCap && ratio >= 1) [messageOnly, reason] = [true, 'hard_cap'];
  }
  if (sub) {
    const days = (now - new Date(sub.status_changed_at)) / 864e5;
    if ((sub.status === 'past_due' || sub.status === 'paused') && days >= GRACE_DAYS) [messageOnly, reason] = [true, sub.status];
    if (sub.status === 'cancelled') [messageOnly, reason] = [true, 'cancelled'];
  }
  return { notify, messageOnly, reason };
}

/**
 * Margin report. Pure. rows: one per business with
 * { business_id, plan (or null), status, minutes, cost_voice, cost_llm, cost_telephony, sms_segments }.
 * Revenue: the monthly price plus overage minutes, for active and past_due subscriptions only (a trial is free).
 * Everything in minor units. Returns { businesses, totals }.
 */
export function marginReport(rows, rates) {
  const businesses = rows.map(r => {
    const paying = r.plan && (r.status === 'active' || r.status === 'past_due');
    const overageMinutes = r.plan ? Math.max(0, r.minutes - r.plan.included_minutes) : 0;
    const revenue = paying ? r.plan.monthly_price + overageMinutes * r.plan.overage_per_min : 0;
    const smsCost = r.sms_segments * rates.sms_per_segment;
    const cost = r.cost_voice + r.cost_llm + r.cost_telephony + smsCost;
    return {
      business_id: r.business_id, plan: r.plan?.id ?? null, status: r.status ?? null, currency: r.plan?.currency ?? 'GBP',
      minutes: r.minutes, overage_minutes: overageMinutes, sms_segments: r.sms_segments,
      revenue, cost: round2(cost), cost_breakdown: { voice: round2(r.cost_voice), llm: round2(r.cost_llm), telephony: round2(r.cost_telephony), sms: round2(smsCost) },
      margin: round2(revenue - cost), margin_pct: revenue ? Math.round(1000 * (revenue - cost) / revenue) / 10 : null,
    };
  });
  const sum = k => round2(businesses.reduce((n, b) => n + b[k], 0));
  return { businesses, totals: { revenue: sum('revenue'), cost: sum('cost'), margin: sum('margin'), minutes: sum('minutes') } };
}

const round2 = x => Math.round(x * 100) / 100;

// ---------------- D1 ----------------

async function subscriptionOf(env, businessId) {
  return env.DB.prepare(
    `SELECT s.*, p.id AS p_id, p.name AS p_name, p.currency, p.monthly_price, p.included_minutes, p.overage_per_min, p.sms_included
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.business_id = ?`
  ).bind(businessId).first();
}

const planOf = s => (s ? { id: s.p_id, name: s.p_name, currency: s.currency, monthly_price: s.monthly_price, included_minutes: s.included_minutes, overage_per_min: s.overage_per_min, sms_included: s.sms_included } : null);

async function periodUsage(env, businessId, start, end) {
  const [m, s] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(billed_minutes), 0) AS minutes FROM usage WHERE business_id = ? AND created_at >= ? AND created_at < ?')
      .bind(businessId, start, end).first(),
    env.DB.prepare('SELECT COALESCE(SUM(segments), 0) AS segments FROM sms_usage WHERE business_id = ? AND created_at >= ? AND created_at < ?')
      .bind(businessId, start, end).first(),
  ]);
  return { calls: m.calls, minutes: m.minutes, sms_segments: s.segments };
}

/** Post-call webhook: one usage row per conversation (replays are ignored). Returns true if new. */
export async function recordCallUsage(env, businessId, conversationId, secs, now = new Date()) {
  const c = callCost(secs, costRates(env));
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO usage (conversation_id, business_id, created_at, seconds, billed_minutes, cost_voice, cost_llm, cost_telephony)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(conversationId, businessId, now.toISOString(), Math.max(0, Math.round(Number(secs) || 0)), billedMinutes(secs), c.voice, c.llm, c.telephony).run();
  return r.meta?.changes === 1;
}

/** Send an SMS for a business, recorded for monitoring (tool_events) and billing (sms_usage). */
export async function sendTrackedSms(env, businessId, profile, to, text, purpose) {
  const ok = await trackedNotify(env, businessId, 'sms', () => sendSms(env, profile, to, text));
  if (ok) {
    await env.DB.prepare('INSERT INTO sms_usage (business_id, created_at, segments, purpose) VALUES (?, ?, ?, ?)')
      .bind(businessId, new Date().toISOString(), smsSegments(text), purpose).run();
  }
  return ok;
}

/** Usage block for the owner panel. */
export async function usageForPanel(env, business, now = new Date()) {
  const sub = await subscriptionOf(env, business.id);
  const period = sub ? { start: sub.period_start, end: sub.period_end } : calendarPeriod(now);
  const u = await periodUsage(env, business.id, period.start, period.end);
  const plan = planOf(sub);
  return {
    period_start: period.start, period_end: period.end, status: sub?.status ?? null, plan,
    calls: u.calls, minutes_used: u.minutes, included_minutes: plan?.included_minutes ?? null, sms_segments: u.sms_segments,
    message_only: !!business.message_only, message_only_reason: business.message_only_reason ?? null,
  };
}

const NOTICE_TEXT = {
  80: (fa, used, inc) => (fa ? `هشدار مصرف: ${used} از ${inc} دقیقه پلن این ماه استفاده شده (۸۰٪).` : `Usage: ${used} of your ${inc} plan minutes used (80%).`),
  100: (fa, used, inc, hard) => (fa
    ? `دقیقه‌های پلن این ماه تمام شد (${used} از ${inc}). ${hard ? 'منشی فقط پیام می‌گیرد تا دوره بعد.' : 'منشی ادامه می‌دهد و دقیقه‌های اضافه حساب می‌شود.'}`
    : `Your ${inc} plan minutes are used up (${used}). ${hard ? 'The receptionist now only takes messages until the next period.' : 'The receptionist keeps answering; extra minutes are billed.'}`),
};

async function notifyOwners(env, business, text) {
  const p = business.profile;
  await trackedNotify(env, business.id, 'telegram', () => sendTelegram(env, p, text));
  const owners = (await env.DB.prepare("SELECT phone, email FROM users WHERE business_id = ? AND role = 'owner'").bind(business.id).all()).results || [];
  for (const o of owners) {
    if (o.phone) await sendTrackedSms(env, business.id, p, o.phone, text, 'usage_notice');
    else if (o.email) await sendEmail(env, o.email, 'Receptionist usage', text);
  }
}

/** Evaluate the rules for one business and act: notices (once per period) and message-only mode. */
export async function applyUsageRules(env, business, now = new Date()) {
  const sub = await subscriptionOf(env, business.id);
  const period = sub ? { start: sub.period_start, end: sub.period_end } : calendarPeriod(now);
  const used = (await periodUsage(env, business.id, period.start, period.end)).minutes;
  const sent = ((await env.DB.prepare('SELECT kind FROM usage_notices WHERE business_id = ? AND period_start = ?')
    .bind(business.id, period.start).all()).results || []).map(r => r.kind);
  const plan = planOf(sub);
  const hardCap = !!business.profile.hard_cap;
  const res = usageRules({ plan, sub, usedMinutes: used, hardCap, sent, now });
  const fa = (business.profile.languages || ['fa'])[0] !== 'en';

  for (const kind of res.notify) {
    const r = await env.DB.prepare('INSERT OR IGNORE INTO usage_notices (business_id, period_start, kind, sent_at) VALUES (?, ?, ?, ?)')
      .bind(business.id, period.start, kind, now.toISOString()).run();
    if (r.meta?.changes === 1) await notifyOwners(env, business, NOTICE_TEXT[kind](fa, used, plan.included_minutes, hardCap));
  }

  if (res.messageOnly !== !!business.message_only || (res.messageOnly && res.reason !== business.message_only_reason)) {
    await env.DB.prepare('UPDATE businesses SET message_only = ?, message_only_reason = ? WHERE id = ?')
      .bind(res.messageOnly ? 1 : 0, res.reason, business.id).run();
    console.log(JSON.stringify({ evt: 'message_only', business_id: business.id, on: res.messageOnly, reason: res.reason }));
  }
  return { ...res, used, period };
}

/** Hourly cron: every business with a subscription (or in message-only mode, so it can be switched back). */
export async function runUsageRules(env, loadBusiness, now = new Date()) {
  const r = await env.DB.prepare(
    'SELECT b.id FROM businesses b LEFT JOIN subscriptions s ON s.business_id = b.id WHERE s.business_id IS NOT NULL OR b.message_only = 1'
  ).all();
  for (const { id } of r.results || []) {
    try {
      await applyUsageRules(env, await loadBusiness(env, id), now);
    } catch (e) {
      console.error(JSON.stringify({ evt: 'usage_rules_failed', business_id: id, error: String(e?.message || e) }));
    }
  }
}

/** GET /admin/usage?period=YYYY-MM: revenue vs estimated cost per business for that calendar month. */
export async function usageReport(env, month) {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const rows = (await env.DB.prepare(
    `SELECT b.id AS business_id, s.status, p.id AS p_id, p.name AS p_name, p.currency, p.monthly_price, p.included_minutes, p.overage_per_min, p.sms_included,
            (SELECT COALESCE(SUM(billed_minutes), 0) FROM usage u WHERE u.business_id = b.id AND u.created_at >= ?1 AND u.created_at < ?2) AS minutes,
            (SELECT COALESCE(SUM(cost_voice), 0) FROM usage u WHERE u.business_id = b.id AND u.created_at >= ?1 AND u.created_at < ?2) AS cost_voice,
            (SELECT COALESCE(SUM(cost_llm), 0) FROM usage u WHERE u.business_id = b.id AND u.created_at >= ?1 AND u.created_at < ?2) AS cost_llm,
            (SELECT COALESCE(SUM(cost_telephony), 0) FROM usage u WHERE u.business_id = b.id AND u.created_at >= ?1 AND u.created_at < ?2) AS cost_telephony,
            (SELECT COALESCE(SUM(segments), 0) FROM sms_usage x WHERE x.business_id = b.id AND x.created_at >= ?1 AND x.created_at < ?2) AS sms_segments
       FROM businesses b LEFT JOIN subscriptions s ON s.business_id = b.id LEFT JOIN plans p ON p.id = s.plan_id ORDER BY b.id`
  ).bind(start, end).all()).results || [];
  const report = marginReport(rows.map(r => ({ ...r, plan: r.p_id ? planOf({ ...r }) : null })), costRates(env));
  return { period: month, from: start, to: end, ...report };
}

/** PUT /admin/subscriptions — until Stripe (M6) drives it. */
export async function upsertSubscription(env, b, now = new Date()) {
  const statuses = ['trial', 'active', 'past_due', 'paused', 'cancelled'];
  if (!b.business_id || !b.plan_id || !statuses.includes(b.status) || !b.period_start || !b.period_end) return { ok: false, error: 'need business_id, plan_id, status, period_start, period_end' };
  const prev = await env.DB.prepare('SELECT status, status_changed_at FROM subscriptions WHERE business_id = ?').bind(b.business_id).first();
  const changedAt = b.status_changed_at || (prev && prev.status === b.status ? prev.status_changed_at : now.toISOString());
  await env.DB.prepare(
    `INSERT INTO subscriptions (business_id, plan_id, status, period_start, period_end, trial_end, status_changed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(business_id) DO UPDATE SET plan_id = excluded.plan_id, status = excluded.status, period_start = excluded.period_start,
       period_end = excluded.period_end, trial_end = excluded.trial_end, status_changed_at = excluded.status_changed_at, updated_at = excluded.updated_at`
  ).bind(b.business_id, b.plan_id, b.status, b.period_start, b.period_end, b.trial_end ?? null, changedAt, now.toISOString()).run();
  return { ok: true };
}
