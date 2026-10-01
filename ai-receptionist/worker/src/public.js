// M8 — public API for the landing page, self-serve sign-up, the funnel and the trial reminder.
//
//   GET  /api/public/config    demo number, trial length, voices to choose from, VAT display
//   GET  /api/public/plans     pricing table (from the plans table)
//   POST /api/public/event     { event: 'visit' | 'demo_call' } page-side funnel steps (no cookies)
//   POST /api/public/contact   { name, contact, message } -> team Telegram
//   POST /api/public/signup    { business_name, owner_name, phone, email?, business_type? } -> account + login code
//   GET  /admin/funnel?days=30 (admin)

import { normalizePhone, addDays } from './lib.js';
import { rateLimit, issueCode, parseIdentifier } from './auth.js';
import { draftProfile, BUSINESS_TYPES } from './profile.js';
import { sendTeamAlert, sendTelegram } from './notify.js';
import { sendEmail } from './email.js';
import { sendTrackedSms } from './usage.js';

export const TRIAL_DAYS = 14;
const PAGE_EVENTS = new Set(['visit', 'demo_call']);
export const FUNNEL = ['visit', 'demo_call', 'signup', 'wizard_done', 'preview_call', 'forwarding_on', 'paid'];

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const ip = request => request.headers.get('cf-connecting-ip') || 'unknown';
const today = () => new Date().toISOString().slice(0, 10);

export async function countFunnel(env, event, day = today()) {
  await env.DB.prepare('INSERT INTO funnel_counts (day, event, count) VALUES (?, ?, 1) ON CONFLICT(day, event) DO UPDATE SET count = count + 1')
    .bind(day, event).run();
}

/** A business-level funnel step, counted once per business however often it happens. */
export async function funnelOnce(env, businessId, event) {
  try {
    const r = await env.DB.prepare("INSERT OR IGNORE INTO funnel_marks (business_id, event, at) VALUES (?, ?, datetime('now'))").bind(businessId, event).run();
    if (r.meta?.changes === 1) await countFunnel(env, event);
  } catch (e) {
    console.error(JSON.stringify({ evt: 'funnel_failed', event, error: String(e?.message || e) }));
  }
}

/** Readable, unique business id from the name (Latin letters only; Persian names get a random suffix id). */
export function slugFor(name, suffix) {
  const base = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${base.length >= 3 ? base : 'business'}-${suffix}`;
}

function voices(env) {
  try { return JSON.parse(env.ELEVENLABS_VOICES || '{}').options || []; } catch { return []; }
}

export async function handlePublic(request, env, ctx, path) {
  const method = request.method;
  if (path === '/api/public/config' && method === 'GET') {
    return json({
      ok: true, demo_number: env.DEMO_NUMBER || null, trial_days: TRIAL_DAYS, business_types: BUSINESS_TYPES,
      voices: voices(env).map(v => ({ id: v.id, lang: v.lang, label_fa: v.label_fa, label_en: v.label_en, sample_url: v.sample_url })),
      prices_include_vat: env.PRICES_INCLUDE_VAT === 'true',
    });
  }
  if (path === '/api/public/plans' && method === 'GET') {
    const r = await env.DB.prepare('SELECT id, name, currency, monthly_price, included_minutes, overage_per_min FROM plans WHERE active = 1 ORDER BY monthly_price').all();
    return json({ ok: true, plans: r.results || [] });
  }
  if (method !== 'POST') return json({ ok: false, error: 'not_found' }, 404);
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) return json({ ok: false, error: 'json_required' }, 415);
  const body = await request.json().catch(() => ({}));

  if (path === '/api/public/event') {
    if (!PAGE_EVENTS.has(body.event)) return json({ ok: false, error: 'bad_event' }, 400);
    // One count per visitor and event per hour; the IP is only used as a rate-limit key, never stored with the count.
    if (await rateLimit(env, `funnel:${body.event}:${ip(request)}`, { max: 1, windowSec: 3600 })) await countFunnel(env, body.event);
    return json({ ok: true });
  }

  if (path === '/api/public/contact') {
    const name = String(body.name || '').trim().slice(0, 80);
    const contact = String(body.contact || '').trim().slice(0, 120);
    const message = String(body.message || '').trim().slice(0, 1000);
    if (!name || !contact || !message) return json({ ok: false, error: 'missing_fields' }, 400);
    if (!await rateLimit(env, `contact:${ip(request)}`, { max: 5, windowSec: 3600 })) return json({ ok: false, error: 'rate_limited' }, 429);
    ctx.waitUntil(sendTeamAlert(env, `📨 Website contact from ${name} (${contact})\n${message}`));
    return json({ ok: true });
  }

  if (path === '/api/public/signup') return signup(env, ctx, request, body);
  return json({ ok: false, error: 'not_found' }, 404);
}

async function signup(env, ctx, request, b) {
  const businessName = String(b.business_name || '').trim().slice(0, 80);
  const ownerName = String(b.owner_name || '').trim().slice(0, 80);
  const phone = normalizePhone(b.phone);
  const email = b.email ? parseIdentifier(b.email) : null;
  if (!businessName || !ownerName) return json({ ok: false, error: 'missing_fields' }, 400);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 400);
  if (b.email && email?.kind !== 'email') return json({ ok: false, error: 'bad_email' }, 400);
  if (!await rateLimit(env, `signup:${ip(request)}`, { max: 5, windowSec: 3600 })) return json({ ok: false, error: 'rate_limited' }, 429);
  if (!await rateLimit(env, `code:id:${phone}`, { max: 3, windowSec: 15 * 60 })) return json({ ok: false, error: 'rate_limited' }, 429);

  // An existing account just gets a login code (same answer, so the form cannot be used to find customers).
  let user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first();
  if (!user) {
    const type = BUSINESS_TYPES.includes(b.business_type) ? b.business_type : 'other';
    const id = slugFor(businessName, Array.from(crypto.getRandomValues(new Uint8Array(3)), x => x.toString(16).padStart(2, '0')).join(''));
    const profile = draftProfile({ business_id: id, business_name: businessName, business_type: type });
    const start = today();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO businesses (id, profile_json, active, signup_source, created_at, updated_at) VALUES (?, ?, 0, 'self_serve', datetime('now'), datetime('now'))`
        ).bind(id, JSON.stringify(profile)),
        env.DB.prepare(
          `INSERT INTO users (business_id, name, phone, email, role, created_at) VALUES (?, ?, ?, ?, 'owner', datetime('now'))`
        ).bind(id, ownerName, phone, email?.value ?? null),
        env.DB.prepare(
          `INSERT INTO subscriptions (business_id, plan_id, status, period_start, period_end, trial_end, status_changed_at, updated_at)
           VALUES (?, 'basic', 'trial', ?, ?, ?, ?, ?)`
        ).bind(id, start, addDays(start, 30), addDays(start, TRIAL_DAYS), new Date().toISOString(), new Date().toISOString()),
      ]);
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) return json({ ok: false, error: 'email_taken' }, 409);
      throw e;
    }
    user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first();
    await funnelOnce(env, id, 'signup');
    ctx.waitUntil(sendTeamAlert(env, `🆕 Self-serve sign-up: ${businessName} (${id}), ${ownerName}`));
  }
  const code = await issueCode(env, user);
  ctx.waitUntil(sendTrackedSms(env, user.business_id || 'team', null, phone, `کد ورود به پنل منشی: ${code}\nYour receptionist code: ${code}`, 'login'));
  return json({ ok: true, channel: 'phone' });
}

/** GET /admin/funnel?days=30: per-step totals and conversion from the previous step. */
export async function funnelReport(env, days = 30) {
  const since = addDays(today(), -Math.max(1, Math.min(days, 365)) + 1);
  const rows = (await env.DB.prepare('SELECT event, SUM(count) AS n FROM funnel_counts WHERE day >= ? GROUP BY event').bind(since).all()).results || [];
  const by = Object.fromEntries(rows.map(r => [r.event, r.n]));
  const steps = FUNNEL.map((event, i) => {
    const n = by[event] || 0;
    const prev = i ? by[FUNNEL[i - 1]] || 0 : null;
    return { event, count: n, from_previous: prev ? Math.round((1000 * n) / prev) / 10 : null };
  });
  return { since, steps };
}

/** Daily: on day 10 of a 14-day trial, remind the owner with what the receptionist did so far (once). */
export async function trialReminders(env, now = new Date()) {
  const due = addDays(now.toISOString().slice(0, 10), TRIAL_DAYS - 10);
  const rows = (await env.DB.prepare(
    "SELECT s.business_id, s.trial_end, b.profile_json FROM subscriptions s JOIN businesses b ON b.id = s.business_id WHERE s.status = 'trial' AND s.trial_end = ? AND s.stripe_subscription_id IS NULL"
  ).bind(due).all()).results || [];
  for (const r of rows) {
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO usage_notices (business_id, period_start, kind, sent_at) VALUES (?, ?, 'trial_reminder', ?)")
      .bind(r.business_id, r.trial_end, now.toISOString()).run();
    if (claim.meta?.changes !== 1) continue;
    const [calls, bookings, messages] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM calls WHERE business_id = ?').bind(r.business_id).first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE business_id = ? AND source = 'phone_ai'").bind(r.business_id).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE business_id = ?').bind(r.business_id).first(),
    ]);
    const p = JSON.parse(r.profile_json);
    const text = `${p.business_name}: ۴ روز از دوره آزمایشی منشی مانده. تا الان ${calls.n} تماس، ${bookings.n} نوبت و ${messages.n} پیام. برای ادامه، از پنل (حساب) اشتراک را شروع کنید.\n`
      + `4 days of your trial left: ${calls.n} calls, ${bookings.n} bookings, ${messages.n} messages so far. Subscribe in the panel (Account) to keep it running.`;
    await sendTelegram(env, p, text);
    const owners = (await env.DB.prepare("SELECT phone, email FROM users WHERE business_id = ? AND role = 'owner'").bind(r.business_id).all()).results || [];
    for (const o of owners) {
      if (o.phone) await sendTrackedSms(env, r.business_id, p, o.phone, text, 'trial_reminder');
      else if (o.email) await sendEmail(env, o.email, 'Your receptionist trial', text);
    }
  }
  return rows.length;
}
