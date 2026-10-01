// AI Receptionist — tool backend for ElevenLabs Agents (Cloudflare Worker + D1).
//
// Tool routes (Bearer TOOL_SECRET):   POST /b/:businessId/{availability|book|find-bookings|reschedule|cancel|message}
// ElevenLabs post-call webhook:       POST /webhooks/post-call   (HMAC, ELEVENLABS_WEBHOOK_SECRET)
// Stripe webhook:                     POST /webhooks/stripe      (Stripe-Signature, STRIPE_WEBHOOK_SECRET) (M6)
// Admin (Bearer ADMIN_SECRET):        PUT  /admin/businesses      body: { agent_id?, profile, active? }
//                                     GET  /admin/b/:businessId/bookings?date=YYYY-MM-DD
//                                     GET  /admin/b/:businessId/calls?limit=20
//                                     GET  /admin/health          last 24 h per business (M2)
//                                     PUT  /admin/users           body: { business_id?, name, phone?, email?, role } (M3)
//                                     PUT  /admin/subscriptions   body: { business_id, plan_id, status, period_start, period_end } (M4)
//                                     GET  /admin/usage?period=YYYY-MM   margin report (M4)
//                                     POST /admin/provisioning/setup     one-off ElevenLabs workspace secret (M5)
//                                     POST /admin/stripe/setup           Stripe products + prices for every plan (M6)
//                                     POST /admin/b/:businessId/provision { action: create|sync|attach-number|pause|resume|delete } (M5)
// Owner panel API (session cookie):   /api/*  (see panel.js); the panel itself is static, served from ../web (M3)
// Public API (landing page, M8):      /api/public/*  (see public.js); the landing page is web/index.html
//                                     GET  /admin/funnel?days=30  sales funnel (M8)
// Health:                             GET  /health
// Crons (wrangler.toml):              */5 * * * *  alert rules -> team Telegram chat (M2)
//                                     17 3 * * *   retention + daily synthetic check (M2) + agent drift check (M5)
//                                     7 * * * *    usage thresholds and message-only mode (M4)
//
// Tool responses are always HTTP 200 with { ok: true, ... } or
// { ok: false, error, message_for_agent } so the voice agent can explain the problem to the caller.

import {
  parseHHMM, fmtHHMM, isValidDate, normalizePhone, londonNow, safeEqual, verifyElevenLabsSignature,
  bookingSms, cancelSms, formatDate,
} from './lib.js';
import { fail, loadBusiness, findService, freeSlots, createBooking, moveBooking, cancelBooking } from './bookings.js';
import { sendTelegram } from './notify.js';
import { logToolEvent, recordEvent, trackedNotify, runAlerts, runSynthetic, healthSummary } from './monitor.js';
import { handleApi } from './panel.js';
import { handlePublic, funnelOnce, funnelReport, trialReminders } from './public.js';
import { parseIdentifier } from './auth.js';
import { setup as provisioningSetup, provisionAction, ProvisionError, driftCheck, deleteExpiredAgents } from './provisioning.js';
import { stripeWebhook, setupStripe, BillingError } from './billing.js';
import { recordCallUsage, applyUsageRules, runUsageRules, usageReport, upsertSubscription, sendTrackedSms } from './usage.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
// Tool results are plain objects ({ ok, ... } or fail()); the router turns them into HTTP 200 responses.
const SERVER_ERROR = 'The booking system had a problem. Apologise, do not confirm anything, and take a message.';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      // "/" is the landing page (static asset); this is the API health check.
      if ((path === '/' || path === '/health') && request.method === 'GET') return json({ ok: true, service: 'ai-receptionist' });

      if (path === '/webhooks/post-call' && request.method === 'POST') return postCall(request, env, ctx);
      if (path === '/webhooks/stripe' && request.method === 'POST') {
        const r = await stripeWebhook(env, request);
        return json(r.body, r.status);
      }

      if (path.startsWith('/api/public/')) return await handlePublic(request, env, ctx, path);
      if (path.startsWith('/api/')) return await handleApi(request, env, ctx, path, url);

      if (path.startsWith('/admin/')) {
        if (!authorized(request, env.ADMIN_SECRET)) return json({ ok: false, error: 'unauthorized' }, 401);
        return admin(request, env, path, url);
      }

      const m = /^\/b\/([a-z0-9-]{2,64})\/([a-z-]+)$/.exec(path);
      if (m && request.method === 'POST') {
        if (!authorized(request, env.TOOL_SECRET)) return json({ ok: false, error: 'unauthorized' }, 401);
        const body = await request.json().catch(() => ({}));
        return json(await timedTool(m[1], m[2], body, env, ctx));
      }
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (err) {
      console.error(JSON.stringify({ evt: 'unhandled', error: String(err?.message || err) }));
      return json(fail('server_error', SERVER_ERROR));
    }
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '*/5 * * * *') {
      await runAlerts(env);
      return;
    }
    if (event.cron === '7 * * * *') {
      await runUsageRules(env, loadBusiness);
      return;
    }
    // Daily (17 3 * * *): GDPR retention — drop transcripts and old messages after RETENTION_DAYS,
    // monitoring events after 30 days — then the synthetic check of every active business.
    const days = Number(env.RETENTION_DAYS || 90);
    await env.DB.batch([
      env.DB.prepare(`UPDATE calls SET transcript_json = NULL WHERE created_at < datetime('now', ?)`).bind(`-${days} days`),
      env.DB.prepare(`DELETE FROM messages WHERE created_at < datetime('now', ?)`).bind(`-${days} days`),
      env.DB.prepare('DELETE FROM tool_events WHERE ts < ?').bind(new Date(Date.now() - 30 * 864e5).toISOString()),
    ]);
    const quietCtx = { waitUntil: p => ctx.waitUntil(p) };
    await runSynthetic(env, (name, business, body) => tool(name, business, body, env, quietCtx));
    await driftCheck(env);
    await trialReminders(env);
    await deleteExpiredAgents(env);
  },
};

// Runs one tool call, logs one JSON line and records it in tool_events (no personal data in either).
async function timedTool(businessId, name, body, env, ctx) {
  const started = Date.now();
  let result;
  try {
    const business = await loadBusiness(env, businessId);
    result = business ? await tool(name, business, body, env, ctx) : fail('unknown_business', 'System problem. Apologise and take a message.');
  } catch (err) {
    console.error(JSON.stringify({ evt: 'tool_exception', business_id: businessId, tool: name, error: String(err?.message || err) }));
    result = fail('server_error', SERVER_ERROR);
  }
  const evt = { ts: new Date().toISOString(), business_id: businessId, tool: name, ok: !!result.ok, error: result.ok ? null : result.error, ms: Date.now() - started };
  logToolEvent(evt);
  ctx.waitUntil(recordEvent(env, evt));
  return result;
}

function authorized(request, secret) {
  const h = request.headers.get('authorization') || '';
  return !!secret && safeEqual(h, `Bearer ${secret}`);
}

// The caller must give the phone number the booking was made with before they can change it.
function confirmedForCaller(env, businessId, bookingId, phone) {
  return env.DB.prepare(
    "SELECT * FROM bookings WHERE id = ? AND business_id = ? AND customer_phone = ? AND status = 'confirmed'"
  ).bind(bookingId, businessId, phone).first();
}

// ---------------- tools ----------------
// Agent-facing wrappers around the shared booking core (bookings.js): they add notifications and shape
// the JSON the voice agent reads.

async function tool(name, business, body, env, ctx) {
  const p = business.profile;
  const sms = (to, text, purpose) => ctx.waitUntil(sendTrackedSms(env, business.id, p, to, text, purpose));
  const telegram = text => ctx.waitUntil(trackedNotify(env, business.id, 'telegram', () => sendTelegram(env, p, text)));
  // Message-only mode (M4: plan used up with a hard cap, or unpaid after the grace period).
  if (p.message_only && name !== 'message') {
    return fail('message_only', 'Bookings by phone are paused for this business right now. Do not book, change or cancel. Offer to take a message with take_message.');
  }
  if (p.booking_provider === 'external' && name !== 'message') return externalProvider(name, business, body, env);

  switch (name) {
    case 'availability': {
      const res = await freeSlots(env, business, body);
      if (!res.ok) return res;
      const slots = res.slots.slice(0, 6);
      return {
        ok: true, date: body.date, day: formatDate(body.date, 'en'), service: res.service.name_en,
        duration_min: res.service.duration_min, price: res.service.price ?? res.service.price_gbp, currency: p.currency || 'GBP', slots,
        note: slots.length ? 'Offer at most 3 of these.' : 'Fully booked that day. Offer another day.',
      };
    }

    case 'book': {
      // dry_run validates everything, writes nothing, notifies nobody (used by the daily synthetic check).
      const b = await createBooking(env, business, body, { source: 'phone_ai', dryRun: body.dry_run === true });
      if (!b.ok) return b;
      if (b.dry_run) return { ok: true, dry_run: true, date: b.date, time: fmtHHMM(b.start), service: b.service.name_en };
      const serviceName = b.lang === 'fa' ? b.service.name_fa : b.service.name_en;
      if (p.sms_enabled) {
        sms(b.phone, bookingSms({ lang: b.lang, businessName: p.business_name, serviceName, date: b.date, time: fmtHHMM(b.start), id: b.id, address: p.address }), 'booking');
      }
      telegram(`✅ New booking ${b.id}\n${b.service.name_en} — ${formatDate(b.date, 'en')} ${fmtHHMM(b.start)}\n${b.name} · ${b.phone}${body.notes ? `\nNote: ${body.notes}` : ''}`);
      return { ok: true, booking_id: b.id, date: b.date, time: fmtHHMM(b.start), service: b.service.name_en, sms_sent: !!p.sms_enabled };
    }

    case 'find-bookings': {
      const phone = normalizePhone(body.customer_phone);
      if (!phone) return fail('bad_phone', 'The phone number looks wrong. Ask for it again.');
      const today = londonNow(new Date(), p.timezone).date;
      const r = await env.DB.prepare(
        "SELECT id, service_id, date, start_min FROM bookings WHERE business_id = ? AND customer_phone = ? AND status = 'confirmed' AND date >= ? ORDER BY date, start_min LIMIT 5"
      ).bind(business.id, phone, today).all();
      const bookings = (r.results || []).map(b => ({
        booking_id: b.id, service: findService(p, b.service_id)?.name_en || b.service_id,
        date: b.date, day: formatDate(b.date, 'en'), time: fmtHHMM(b.start_min),
      }));
      if (!bookings.length) return fail('not_found', 'No upcoming booking for that number. Ask if they used another number, or take a message.');
      return { ok: true, bookings };
    }

    case 'reschedule': {
      const phone = normalizePhone(body.customer_phone);
      if (!phone || !isValidDate(body.new_date) || parseHHMM(body.new_time) == null) return fail('bad_input', 'Check the phone number, new date and new time.');
      const old = await confirmedForCaller(env, business.id, body.booking_id, phone);
      if (!old) return fail('not_found', 'Booking not found for that number. Use find_bookings first.');
      const m = await moveBooking(env, business, old, body.new_date, body.new_time);
      if (!m.ok) return m;
      const lang = old.language === 'fa' ? 'fa' : 'en';
      const serviceName = lang === 'fa' ? m.service.name_fa : m.service.name_en;
      if (p.sms_enabled) sms(phone, bookingSms({ lang, businessName: p.business_name, serviceName, date: m.date, time: fmtHHMM(m.start), id: old.id, address: p.address }), 'booking');
      telegram(`🔁 Moved ${old.id}: ${formatDate(old.date, 'en')} ${fmtHHMM(old.start_min)} → ${formatDate(m.date, 'en')} ${fmtHHMM(m.start)}\n${old.customer_name} · ${phone}`);
      return { ok: true, booking_id: old.id, date: m.date, time: fmtHHMM(m.start) };
    }

    case 'cancel': {
      const phone = normalizePhone(body.customer_phone);
      if (!phone) return fail('bad_phone', 'The phone number looks wrong.');
      const old = await confirmedForCaller(env, business.id, body.booking_id, phone);
      if (!old) return fail('not_found', 'Booking not found for that number. Use find_bookings first.');
      await cancelBooking(env, business, old.id);
      const lang = old.language === 'fa' ? 'fa' : 'en';
      if (p.sms_enabled) sms(phone, cancelSms({ lang, businessName: p.business_name, date: old.date, time: fmtHHMM(old.start_min), id: old.id }), 'cancel');
      telegram(`❌ Cancelled ${old.id}: ${formatDate(old.date, 'en')} ${fmtHHMM(old.start_min)}\n${old.customer_name} · ${phone}`);
      return { ok: true, booking_id: old.id, cancelled: true };
    }

    case 'message': {
      const phone = normalizePhone(body.caller_phone) || String(body.caller_phone || '').slice(0, 30);
      const urgent = body.urgency === 'urgent';
      await env.DB.prepare(
        "INSERT INTO messages (business_id, caller_name, caller_phone, message, urgency, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).bind(business.id, String(body.caller_name || '').slice(0, 80), phone, String(body.message || '').slice(0, 1000), urgent ? 'urgent' : 'normal').run();
      telegram(`${urgent ? '🚨 URGENT message' : '📩 Message'} from ${body.caller_name || 'caller'} (${phone})\n${body.message || ''}`);
      return { ok: true, delivered: true, note: 'Tell the caller the team will call them back. Do not promise a time.' };
    }

    default:
      return fail('unknown_tool', 'System problem. Apologise and take a message.');
  }
}

// Forward tool calls to our own booking product when a business already uses it.
// Contract: same path and JSON body; the external API must answer with the same response shape.
async function externalProvider(name, business, body, env) {
  if (!env.EXTERNAL_BOOKING_API) return fail('not_configured', 'Booking system not connected. Take a message.');
  const r = await fetch(`${env.EXTERNAL_BOOKING_API.replace(/\/$/, '')}/b/${business.id}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.EXTERNAL_BOOKING_KEY || '' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return fail('external_error', 'The booking system did not answer. Apologise and take a message.');
  return r.json();
}

// ---------------- post-call webhook ----------------

async function postCall(request, env, ctx) {
  const raw = await request.text();
  const ok = await verifyElevenLabsSignature(env.ELEVENLABS_WEBHOOK_SECRET, request.headers.get('elevenlabs-signature'), raw);
  if (!ok) return json({ ok: false, error: 'bad_signature' }, 401);
  const evt = JSON.parse(raw);
  if (evt.type !== 'post_call_transcription') return json({ ok: true, ignored: evt.type });

  const d = evt.data || {};
  const row = await env.DB.prepare('SELECT id FROM businesses WHERE agent_id = ?').bind(d.agent_id).first();
  if (!row) return json({ ok: true, ignored: 'unknown_agent' });
  const biz = await loadBusiness(env, row.id);
  const p = biz.profile;

  const meta = d.metadata || {};
  const caller = meta.phone_call?.external_number || d.conversation_initiation_client_data?.dynamic_variables?.system__caller_id || 'hidden';
  const duration = meta.call_duration_secs || 0;
  const summary = d.analysis?.transcript_summary || '';
  const success = d.analysis?.call_successful || 'unknown';
  const collected = d.analysis?.data_collection_results || {};

  await env.DB.prepare(
    `INSERT OR REPLACE INTO calls (conversation_id, business_id, agent_id, caller, duration_secs, summary, success, data_json, transcript_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(d.conversation_id, biz.id, d.agent_id, caller, duration, summary, success,
    JSON.stringify(collected), JSON.stringify(d.transcript || [])).run();

  // Funnel (M8): the first call a self-serve business gets is its preview call.
  ctx.waitUntil(env.DB.prepare('SELECT signup_source FROM businesses WHERE id = ?').bind(biz.id).first()
    .then(r => (r?.signup_source === 'self_serve' ? funnelOnce(env, biz.id, 'preview_call') : null)));

  // Usage (M4): one row per conversation (replays ignored), then thresholds and message-only mode.
  if (d.conversation_id) {
    await recordCallUsage(env, biz.id, d.conversation_id, duration);
    ctx.waitUntil(applyUsageRules(env, biz).catch(e => console.error(JSON.stringify({ evt: 'usage_rules_failed', business_id: biz.id, error: String(e?.message || e) }))));
  }

  const facts = Object.entries(collected).map(([k, v]) => `${k}: ${v?.value ?? v}`).join('\n');
  ctx.waitUntil(trackedNotify(env, biz.id, 'telegram', () => sendTelegram(env, p, `📞 Call from ${caller} · ${Math.round(duration / 60 * 10) / 10} min · ${success}\n${summary}${facts ? `\n\n${facts}` : ''}`)));
  return json({ ok: true });
}

// ---------------- admin ----------------

async function provisioningResponse(fn) {
  try {
    return json({ ok: true, ...(await fn()) });
  } catch (e) {
    if (e instanceof ProvisionError) return json({ ok: false, error: e.code, message: e.message }, e.status);
    throw e;
  }
}

async function admin(request, env, path, url) {
  if (path === '/admin/businesses' && request.method === 'PUT') {
    const { agent_id = null, profile, active = true } = await request.json();
    if (!profile?.business_id || !/^[a-z0-9-]{2,64}$/.test(profile.business_id)) return json({ ok: false, error: 'profile.business_id must be a lowercase slug' }, 400);
    await env.DB.prepare(
      `INSERT INTO businesses (id, agent_id, profile_json, active, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET agent_id = COALESCE(excluded.agent_id, businesses.agent_id), profile_json = excluded.profile_json,
         active = excluded.active, needs_sync = 1, updated_at = datetime('now')`
    ).bind(profile.business_id, agent_id, JSON.stringify(profile), active ? 1 : 0).run();
    return json({ ok: true, business_id: profile.business_id });
  }
  if (path === '/admin/users' && request.method === 'PUT') {
    // Create the first owner of a business, or a team superadmin (business_id null).
    const b = await request.json();
    const role = ['owner', 'staff', 'superadmin'].includes(b.role) ? b.role : null;
    const phone = b.phone ? normalizePhone(b.phone) : null;
    const email = b.email ? parseIdentifier(b.email)?.value : null;
    if (!role || !b.name || (!phone && !email) || (role !== 'superadmin' && !b.business_id)) {
      return json({ ok: false, error: 'need name, role, phone or email, and business_id (unless superadmin)' }, 400);
    }
    const r = await env.DB.prepare(
      `INSERT INTO users (business_id, name, phone, email, role, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT DO NOTHING RETURNING id`
    ).bind(role === 'superadmin' ? null : b.business_id, String(b.name).slice(0, 80), phone, email, role).first();
    return r ? json({ ok: true, user_id: r.id }) : json({ ok: false, error: 'exists' }, 409);
  }
  if (path === '/admin/subscriptions' && request.method === 'PUT') {
    const r = await upsertSubscription(env, await request.json());
    return json(r, r.ok ? 200 : 400);
  }
  if (path === '/admin/usage' && request.method === 'GET') {
    const period = url.searchParams.get('period') || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return json({ ok: false, error: 'period must be YYYY-MM' }, 400);
    return json({ ok: true, ...(await usageReport(env, period)) });
  }
  if (path === '/admin/stripe/setup' && request.method === 'POST') {
    try {
      return json({ ok: true, ...(await setupStripe(env)) });
    } catch (e) {
      if (e instanceof BillingError) return json({ ok: false, error: e.code, message: e.message }, e.status);
      throw e;
    }
  }
  if (path === '/admin/provisioning/setup' && request.method === 'POST') {
    return provisioningResponse(() => provisioningSetup(env));
  }
  const prov = /^\/admin\/b\/([a-z0-9-]{2,64})\/provision$/.exec(path);
  if (prov && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return provisioningResponse(() => provisionAction(env, prov[1], body));
  }
  if (path === '/admin/funnel' && request.method === 'GET') {
    return json({ ok: true, ...(await funnelReport(env, Number(url.searchParams.get('days')) || 30)) });
  }
  if (path === '/admin/health' && request.method === 'GET') {
    return json({ ok: true, since: new Date(Date.now() - 864e5).toISOString(), businesses: await healthSummary(env) });
  }
  const m = /^\/admin\/b\/([a-z0-9-]{2,64})\/(bookings|calls|messages)$/.exec(path);
  if (m && request.method === 'GET') {
    const [, id, kind] = m;
    if (kind === 'bookings') {
      const date = url.searchParams.get('date');
      const r = date
        ? await env.DB.prepare('SELECT * FROM bookings WHERE business_id = ? AND date = ? ORDER BY start_min').bind(id, date).all()
        : await env.DB.prepare("SELECT * FROM bookings WHERE business_id = ? AND date >= date('now') ORDER BY date, start_min LIMIT 200").bind(id).all();
      return json({ ok: true, bookings: (r.results || []).map(b => ({ ...b, time: fmtHHMM(b.start_min) })) });
    }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
    const table = kind === 'calls' ? 'calls' : 'messages';
    const r = await env.DB.prepare(`SELECT * FROM ${table} WHERE business_id = ? ORDER BY created_at DESC LIMIT ?`).bind(id, limit).all();
    return json({ ok: true, [kind]: r.results || [] });
  }
  return json({ ok: false, error: 'not_found' }, 404);
}
