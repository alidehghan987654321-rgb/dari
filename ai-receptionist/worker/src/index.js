// AI Receptionist — tool backend for ElevenLabs Agents (Cloudflare Worker + D1).
//
// Tool routes (Bearer TOOL_SECRET):   POST /b/:businessId/{availability|book|find-bookings|reschedule|cancel|message}
// ElevenLabs post-call webhook:       POST /webhooks/post-call   (HMAC, ELEVENLABS_WEBHOOK_SECRET)
// Admin (Bearer ADMIN_SECRET):        PUT  /admin/businesses      body: { agent_id?, profile }
//                                     GET  /admin/b/:businessId/bookings?date=YYYY-MM-DD
//                                     GET  /admin/b/:businessId/calls?limit=20
//
// Tool responses are always HTTP 200 with { ok: true, ... } or
// { ok: false, error, message_for_agent } so the voice agent can explain the problem to the caller.

import {
  computeSlots, sortByPreferred, parseHHMM, fmtHHMM, isValidDate, normalizePhone, londonNow,
  bookingId, safeEqual, verifyElevenLabsSignature, bookingSms, cancelSms, formatDate,
} from './lib.js';
import { sendTelegram, sendSms } from './notify.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const fail = (error, message_for_agent) => json({ ok: false, error, message_for_agent });

const REASON_TEXT = {
  bad_date: 'The date is not valid. Ask the caller for the day again.',
  past_date: 'That date is in the past. Ask for a future day.',
  too_far: 'That date is too far ahead for bookings. Offer a closer date.',
  closed: 'The business is closed on that day. Tell the caller and offer the nearest open day.',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/' && request.method === 'GET') return json({ ok: true, service: 'ai-receptionist' });

      if (path === '/webhooks/post-call' && request.method === 'POST') return postCall(request, env, ctx);

      if (path.startsWith('/admin/')) {
        if (!authorized(request, env.ADMIN_SECRET)) return json({ ok: false, error: 'unauthorized' }, 401);
        return admin(request, env, path, url);
      }

      const m = /^\/b\/([a-z0-9-]{2,64})\/([a-z-]+)$/.exec(path);
      if (m && request.method === 'POST') {
        if (!authorized(request, env.TOOL_SECRET)) return json({ ok: false, error: 'unauthorized' }, 401);
        const business = await loadBusiness(env, m[1]);
        if (!business) return fail('unknown_business', 'System problem. Apologise and take a message.');
        const body = await request.json().catch(() => ({}));
        return tool(m[2], business, body, env, ctx);
      }
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (err) {
      console.error('unhandled', err?.stack || err);
      return fail('server_error', 'The booking system had a problem. Apologise, do not confirm anything, and take a message.');
    }
  },

  // Daily cron (see wrangler.toml): GDPR retention — drop transcripts and old messages after RETENTION_DAYS.
  async scheduled(event, env) {
    const days = Number(env.RETENTION_DAYS || 90);
    await env.DB.batch([
      env.DB.prepare(`UPDATE calls SET transcript_json = NULL WHERE created_at < datetime('now', ?)`).bind(`-${days} days`),
      env.DB.prepare(`DELETE FROM messages WHERE created_at < datetime('now', ?)`).bind(`-${days} days`),
    ]);
  },
};

function authorized(request, secret) {
  const h = request.headers.get('authorization') || '';
  return !!secret && safeEqual(h, `Bearer ${secret}`);
}

async function loadBusiness(env, id) {
  const row = await env.DB.prepare('SELECT id, agent_id, profile_json FROM businesses WHERE id = ?').bind(id).first();
  if (!row) return null;
  return { id: row.id, agent_id: row.agent_id, profile: JSON.parse(row.profile_json) };
}

function findService(profile, id) {
  return (profile.services || []).find(s => s.id === id);
}

async function bookingsOn(env, businessId, date) {
  const r = await env.DB.prepare(
    "SELECT id, start_min, end_min FROM bookings WHERE business_id = ? AND date = ? AND status = 'confirmed'"
  ).bind(businessId, date).all();
  return r.results || [];
}

// ---------------- tools ----------------

async function tool(name, business, body, env, ctx) {
  const p = business.profile;
  if (p.booking_provider === 'external' && name !== 'message') return externalProvider(name, business, body, env);

  switch (name) {
    case 'availability': {
      const service = findService(p, body.service_id);
      if (!service) return fail('unknown_service', `Unknown service. Valid ids: ${p.services.map(s => s.id).join(', ')}.`);
      const res = computeSlots({ profile: p, service, date: body.date, bookings: await bookingsOn(env, business.id, body.date) });
      if (!res.ok) return fail(res.reason, REASON_TEXT[res.reason]);
      const slots = sortByPreferred(res.slots, body.preferred_time).slice(0, 6);
      return json({
        ok: true, date: body.date, day: formatDate(body.date, 'en'), service: service.name_en,
        duration_min: service.duration_min, price_gbp: service.price_gbp, slots,
        note: slots.length ? 'Offer at most 3 of these.' : 'Fully booked that day. Offer another day.',
      });
    }

    case 'book': {
      const service = findService(p, body.service_id);
      if (!service) return fail('unknown_service', 'Unknown service id. Check the business facts.');
      const phone = normalizePhone(body.customer_phone);
      if (!phone) return fail('bad_phone', 'The phone number looks wrong. Ask for it again, digit by digit.');
      const name = String(body.customer_name || '').trim().slice(0, 80);
      if (!name) return fail('missing_name', 'Ask for the caller\'s name.');
      const start = parseHHMM(body.time);
      if (!isValidDate(body.date) || start == null) return fail('bad_time', 'Date or time is not valid. Check availability again.');

      // Re-check with fresh data: slot must still be offered.
      const check = computeSlots({ profile: p, service, date: body.date, bookings: await bookingsOn(env, business.id, body.date) });
      if (!check.ok) return fail(check.reason, REASON_TEXT[check.reason]);
      if (!check.slots.includes(fmtHHMM(start))) {
        return fail('slot_taken', `That time is no longer free. Nearest free times: ${sortByPreferred(check.slots, body.time).slice(0, 3).join(', ') || 'none that day'}.`);
      }

      const id = bookingId();
      const end = start + service.duration_min;
      const lang = body.language === 'fa' ? 'fa' : 'en';
      // Atomic insert: only succeeds if overlap count is still below capacity (guards two simultaneous calls).
      const res = await env.DB.prepare(
        `INSERT INTO bookings (id, business_id, service_id, date, start_min, end_min, customer_name, customer_phone, language, notes, status, source, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'phone_ai', datetime('now')
         WHERE (SELECT COUNT(*) FROM bookings WHERE business_id = ? AND date = ? AND status = 'confirmed' AND start_min < ? AND end_min > ?) < ?`
      ).bind(id, business.id, service.id, body.date, start, end, name, phone, lang, String(body.notes || '').slice(0, 300),
        business.id, body.date, end, start, p.capacity || 1).run();
      if (!res.meta || res.meta.changes !== 1) return fail('slot_taken', 'That time was just taken. Check availability again and offer another time.');

      const serviceName = lang === 'fa' ? service.name_fa : service.name_en;
      if (p.sms_enabled) {
        ctx.waitUntil(sendSms(env, p, phone, bookingSms({ lang, businessName: p.business_name, serviceName, date: body.date, time: fmtHHMM(start), id, address: p.address })));
      }
      ctx.waitUntil(sendTelegram(env, p, `✅ New booking ${id}\n${service.name_en} — ${formatDate(body.date, 'en')} ${fmtHHMM(start)}\n${name} · ${phone}${body.notes ? `\nNote: ${body.notes}` : ''}`));
      return json({ ok: true, booking_id: id, date: body.date, time: fmtHHMM(start), service: service.name_en, sms_sent: !!p.sms_enabled });
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
      return json({ ok: true, bookings });
    }

    case 'reschedule': {
      const phone = normalizePhone(body.customer_phone);
      const start = parseHHMM(body.new_time);
      if (!phone || !isValidDate(body.new_date) || start == null) return fail('bad_input', 'Check the phone number, new date and new time.');
      const old = await env.DB.prepare(
        "SELECT * FROM bookings WHERE id = ? AND business_id = ? AND customer_phone = ? AND status = 'confirmed'"
      ).bind(body.booking_id, business.id, phone).first();
      if (!old) return fail('not_found', 'Booking not found for that number. Use find_bookings first.');
      const service = findService(p, old.service_id);
      const check = computeSlots({ profile: p, service, date: body.new_date, bookings: await bookingsOn(env, business.id, body.new_date), excludeId: old.id });
      if (!check.ok) return fail(check.reason, REASON_TEXT[check.reason]);
      if (!check.slots.includes(fmtHHMM(start))) return fail('slot_taken', `Not free. Nearest: ${sortByPreferred(check.slots, body.new_time).slice(0, 3).join(', ') || 'none that day'}.`);
      const end = start + service.duration_min;
      const res = await env.DB.prepare(
        `UPDATE bookings SET date = ?, start_min = ?, end_min = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'confirmed'
           AND (SELECT COUNT(*) FROM bookings WHERE business_id = ? AND date = ? AND status = 'confirmed' AND id != ? AND start_min < ? AND end_min > ?) < ?`
      ).bind(body.new_date, start, end, old.id, business.id, body.new_date, old.id, end, start, p.capacity || 1).run();
      if (!res.meta || res.meta.changes !== 1) return fail('slot_taken', 'That time was just taken. Check availability again.');
      const lang = old.language === 'fa' ? 'fa' : 'en';
      const serviceName = lang === 'fa' ? service.name_fa : service.name_en;
      if (p.sms_enabled) ctx.waitUntil(sendSms(env, p, phone, bookingSms({ lang, businessName: p.business_name, serviceName, date: body.new_date, time: fmtHHMM(start), id: old.id, address: p.address })));
      ctx.waitUntil(sendTelegram(env, p, `🔁 Moved ${old.id}: ${formatDate(old.date, 'en')} ${fmtHHMM(old.start_min)} → ${formatDate(body.new_date, 'en')} ${fmtHHMM(start)}\n${old.customer_name} · ${phone}`));
      return json({ ok: true, booking_id: old.id, date: body.new_date, time: fmtHHMM(start) });
    }

    case 'cancel': {
      const phone = normalizePhone(body.customer_phone);
      if (!phone) return fail('bad_phone', 'The phone number looks wrong.');
      const old = await env.DB.prepare(
        "SELECT * FROM bookings WHERE id = ? AND business_id = ? AND customer_phone = ? AND status = 'confirmed'"
      ).bind(body.booking_id, business.id, phone).first();
      if (!old) return fail('not_found', 'Booking not found for that number. Use find_bookings first.');
      await env.DB.prepare("UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").bind(old.id).run();
      const lang = old.language === 'fa' ? 'fa' : 'en';
      if (p.sms_enabled) ctx.waitUntil(sendSms(env, p, phone, cancelSms({ lang, businessName: p.business_name, date: old.date, time: fmtHHMM(old.start_min), id: old.id })));
      ctx.waitUntil(sendTelegram(env, p, `❌ Cancelled ${old.id}: ${formatDate(old.date, 'en')} ${fmtHHMM(old.start_min)}\n${old.customer_name} · ${phone}`));
      return json({ ok: true, booking_id: old.id, cancelled: true });
    }

    case 'message': {
      const phone = normalizePhone(body.caller_phone) || String(body.caller_phone || '').slice(0, 30);
      const urgent = body.urgency === 'urgent';
      await env.DB.prepare(
        "INSERT INTO messages (business_id, caller_name, caller_phone, message, urgency, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).bind(business.id, String(body.caller_name || '').slice(0, 80), phone, String(body.message || '').slice(0, 1000), urgent ? 'urgent' : 'normal').run();
      ctx.waitUntil(sendTelegram(env, p, `${urgent ? '🚨 URGENT message' : '📩 Message'} from ${body.caller_name || 'caller'} (${phone})\n${body.message || ''}`));
      return json({ ok: true, delivered: true, note: 'Tell the caller the team will call them back. Do not promise a time.' });
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
  return json(await r.json());
}

// ---------------- post-call webhook ----------------

async function postCall(request, env, ctx) {
  const raw = await request.text();
  const ok = await verifyElevenLabsSignature(env.ELEVENLABS_WEBHOOK_SECRET, request.headers.get('elevenlabs-signature'), raw);
  if (!ok) return json({ ok: false, error: 'bad_signature' }, 401);
  const evt = JSON.parse(raw);
  if (evt.type !== 'post_call_transcription') return json({ ok: true, ignored: evt.type });

  const d = evt.data || {};
  const biz = await env.DB.prepare('SELECT id, profile_json FROM businesses WHERE agent_id = ?').bind(d.agent_id).first();
  if (!biz) return json({ ok: true, ignored: 'unknown_agent' });
  const p = JSON.parse(biz.profile_json);

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

  const facts = Object.entries(collected).map(([k, v]) => `${k}: ${v?.value ?? v}`).join('\n');
  ctx.waitUntil(sendTelegram(env, p, `📞 Call from ${caller} · ${Math.round(duration / 60 * 10) / 10} min · ${success}\n${summary}${facts ? `\n\n${facts}` : ''}`));
  return json({ ok: true });
}

// ---------------- admin ----------------

async function admin(request, env, path, url) {
  if (path === '/admin/businesses' && request.method === 'PUT') {
    const { agent_id = null, profile } = await request.json();
    if (!profile?.business_id || !/^[a-z0-9-]{2,64}$/.test(profile.business_id)) return json({ ok: false, error: 'profile.business_id must be a lowercase slug' }, 400);
    await env.DB.prepare(
      `INSERT INTO businesses (id, agent_id, profile_json, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, profile_json = excluded.profile_json, updated_at = datetime('now')`
    ).bind(profile.business_id, agent_id, JSON.stringify(profile)).run();
    return json({ ok: true, business_id: profile.business_id });
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
