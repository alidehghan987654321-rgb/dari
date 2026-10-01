// M3 — owner panel API: /api/*. Session cookie auth; every business-scoped query is filtered by the business
// resolved from the session (owners/staff: their own only; superadmin: the one they chose).
//
// Public:   POST /api/auth/request-code {identifier}      POST /api/auth/verify {identifier, code}
// Session:  POST /api/auth/logout   GET /api/me   PUT /api/me/prefs   GET /api/businesses (superadmin)
// Business: GET  /api/today
//           GET  /api/bookings?from=YYYY-MM-DD&days=1..14      POST /api/bookings
//           POST /api/bookings/:id/cancel                     POST /api/bookings/:id/move {date, time}
//           GET  /api/availability?service_id=&date=&exclude=
//           GET  /api/calls?limit=&before=   GET /api/calls/:id   GET /api/calls/:id/audio
//           GET  /api/messages?status=open|all                POST /api/messages/:id/done {done}
//           GET  /api/settings   PUT /api/settings (owner)
//           GET  /api/account    POST /api/users (owner)      DELETE /api/users/:id (owner)

import { londonNow, fmtHHMM, isValidDate, addDays, normalizePhone, bookingSms, cancelSms } from './lib.js';
import { loadBusiness, findService, freeSlots, createBooking, moveBooking, cancelBooking, getBooking } from './bookings.js';
import {
  LIMITS, parseIdentifier, rateLimit, findUserByIdentifier, issueCode, checkCode, createSession, sessionUser, endSession,
  sessionCookie, resolveBusiness, canManage,
} from './auth.js';
import { validateSettings, settingsOf, applySettings } from './profile.js';
import { sendSms } from './notify.js';
import { sendEmail } from './email.js';
import { trackedNotify } from './monitor.js';
import { usageForPanel } from './usage.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const err = (error, status = 400, extra = {}) => json({ ok: false, error, ...extra }, status);
const body = request => request.json().catch(() => ({}));
const prefsOf = user => { try { return JSON.parse(user.prefs_json || '{}'); } catch { return {}; } };
/** SQLite datetime('now') format, for comparing with created_at columns. */
const sqlTime = d => d.toISOString().slice(0, 19).replace('T', ' ');

export async function handleApi(request, env, ctx, path, url) {
  const method = request.method;
  // CSRF: a cross-site form can only POST form encodings; a JSON body (or PUT/DELETE at all) needs a CORS
  // preflight, which we never allow. The cookie is also SameSite=Lax.
  if ((method === 'POST' || method === 'PUT') && !(request.headers.get('content-type') || '').startsWith('application/json')) return err('json_required', 415);

  if (path === '/api/auth/request-code' && method === 'POST') return requestCode(request, env, ctx);
  if (path === '/api/auth/verify' && method === 'POST') return verify(request, env);

  const user = await sessionUser(env, request);
  if (!user) return err('unauthorized', 401);

  if (path === '/api/auth/logout' && method === 'POST') {
    await endSession(env, user);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }
  if (path === '/api/businesses' && method === 'GET') {
    if (user.role !== 'superadmin') return err('forbidden', 403);
    const r = await env.DB.prepare('SELECT id, profile_json, active, needs_sync FROM businesses ORDER BY id').all();
    return json({ ok: true, businesses: (r.results || []).map(b => ({ id: b.id, name: JSON.parse(b.profile_json).business_name, active: !!b.active, needs_sync: !!b.needs_sync })) });
  }
  if (path === '/api/me/prefs' && method === 'PUT') {
    const b = await body(request);
    const prefs = { ...prefsOf(user) };
    if (['fa', 'en'].includes(b.lang)) prefs.lang = b.lang;
    if (['fa', 'latn'].includes(b.digits)) prefs.digits = b.digits;
    await env.DB.prepare('UPDATE users SET prefs_json = ? WHERE id = ?').bind(JSON.stringify(prefs), user.id).run();
    return json({ ok: true, prefs });
  }

  const requested = request.headers.get('x-business-id') || url.searchParams.get('b');
  if (path === '/api/me' && method === 'GET' && user.role === 'superadmin' && !requested) return json({ ok: true, user: publicUser(user), business: null });

  const scope = resolveBusiness(user, requested);
  if (!scope.ok) return err(scope.error, scope.status);
  const business = await loadBusiness(env, scope.businessId);
  if (!business) return err('unknown_business', 404);
  return businessRoute(request, env, ctx, path, url, user, business);
}

function publicUser(u) {
  return { id: u.id, name: u.name, role: u.role, phone: u.phone, email: u.email, prefs: prefsOf(u) };
}

// ---------------- auth ----------------

async function requestCode(request, env, ctx) {
  const b = await body(request);
  const id = parseIdentifier(b.identifier);
  if (!id) return err('bad_identifier');
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipOk = await rateLimit(env, `code:ip:${ip}`, LIMITS.ip);
  const idOk = await rateLimit(env, `code:id:${id.value}`, LIMITS.identifier);
  if (!ipOk || !idOk) return err('rate_limited', 429);

  // Same answer whether or not the account exists, so the endpoint cannot be used to find customers.
  const user = await findUserByIdentifier(env, id);
  if (user) {
    const code = await issueCode(env, user);
    const fa = (prefsOf(user).lang || 'fa') === 'fa';
    const text = fa ? `کد ورود به پنل منشی: ${code}\nتا ۱۰ دقیقه معتبر است.` : `Your receptionist panel code: ${code}\nValid for 10 minutes.`;
    const biz = user.business_id || 'team';
    ctx.waitUntil(id.kind === 'phone'
      ? trackedNotify(env, biz, 'sms', () => sendSms(env, null, id.value, text))
      : sendEmail(env, id.value, fa ? 'کد ورود' : 'Your login code', text));
  }
  return json({ ok: true, channel: id.kind });
}

async function verify(request, env) {
  const b = await body(request);
  const id = parseIdentifier(b.identifier);
  if (!id || !/^\d{6}$/.test(String(b.code || '').trim())) return err('bad_code', 401);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!await rateLimit(env, `verify:ip:${ip}`, { max: 30, windowSec: 15 * 60 })) return err('rate_limited', 429);
  const user = await findUserByIdentifier(env, id);
  if (!user) return err('bad_code', 401);
  const res = await checkCode(env, user, b.code);
  if (!res.ok) return err(res.error, 401);
  const token = await createSession(env, user);
  return json({ ok: true, user: publicUser(user) }, 200, { 'set-cookie': sessionCookie(token) });
}

// ---------------- business-scoped ----------------

function bookingView(p, b) {
  const s = findService(p, b.service_id);
  return {
    id: b.id, date: b.date, time: fmtHHMM(b.start_min), end: fmtHHMM(b.end_min), service_id: b.service_id,
    service_en: s?.name_en || b.service_id, service_fa: s?.name_fa || b.service_id,
    customer_name: b.customer_name, customer_phone: b.customer_phone || null, status: b.status, source: b.source,
    notes: b.notes || null, language: b.language,
  };
}

function callView(c) {
  let data = {};
  try { data = JSON.parse(c.data_json || '{}'); } catch { /* keep empty */ }
  const v = k => data[k]?.value ?? data[k] ?? null;
  return {
    id: c.conversation_id, caller: c.caller, duration_secs: c.duration_secs, summary: c.summary, success: c.success,
    created_at: c.created_at, language: v('language'), intent: v('caller_intent'), booking_made: v('booking_made'), callback_needed: v('callback_needed'),
  };
}

async function businessRoute(request, env, ctx, path, url, user, business) {
  const method = request.method;
  const p = business.profile;
  const tz = p.timezone || 'Europe/London';

  if (path === '/api/me' && method === 'GET') {
    return json({ ok: true, user: publicUser(user), business: { id: business.id, name: p.business_name, currency: p.currency || 'GBP', timezone: tz, needs_sync: business.needs_sync, services: (p.services || []).map(s => ({ id: s.id, name_en: s.name_en, name_fa: s.name_fa, duration_min: s.duration_min })) } });
  }

  if (path === '/api/today' && method === 'GET') {
    const now = londonNow(new Date(), tz);
    const since = sqlTime(new Date(Date.now() - now.minutes * 60_000)); // local midnight, to the minute
    const [bookings, calls, unread, usage] = await Promise.all([
      env.DB.prepare('SELECT * FROM bookings WHERE business_id = ? AND date = ? ORDER BY start_min').bind(business.id, now.date).all(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM calls WHERE business_id = ? AND created_at >= ?').bind(business.id, since).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE business_id = ? AND done_at IS NULL').bind(business.id).first(),
      usageForPanel(env, business),
    ]);
    return json({ ok: true, date: now.date, bookings: (bookings.results || []).map(b => bookingView(p, b)), calls_today: calls.n, unread_messages: unread.n, usage });
  }

  if (path === '/api/bookings' && method === 'GET') {
    const from = isValidDate(url.searchParams.get('from')) ? url.searchParams.get('from') : londonNow(new Date(), tz).date;
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 1, 1), 14);
    const r = await env.DB.prepare('SELECT * FROM bookings WHERE business_id = ? AND date >= ? AND date < ? ORDER BY date, start_min')
      .bind(business.id, from, addDays(from, days)).all();
    return json({ ok: true, from, days, bookings: (r.results || []).map(b => bookingView(p, b)) });
  }

  if (path === '/api/availability' && method === 'GET') {
    // `exclude`: a booking being moved does not block its own new time.
    const res = await freeSlots(env, business, {
      service_id: url.searchParams.get('service_id'), date: url.searchParams.get('date'),
      excludeId: url.searchParams.get('exclude'), minNoticeMinutes: 0,
    });
    return res.ok ? json({ ok: true, slots: res.slots }) : err(res.error);
  }

  if (path === '/api/bookings' && method === 'POST') {
    const b = await body(request);
    const res = await createBooking(env, business, { ...b, language: b.language || 'fa' }, { source: 'panel', requirePhone: false, minNoticeMinutes: 0 });
    if (!res.ok) return err(res.error, res.error === 'slot_taken' ? 409 : 400);
    if (b.send_sms && res.phone && p.sms_enabled) {
      const serviceName = res.lang === 'fa' ? res.service.name_fa : res.service.name_en;
      ctx.waitUntil(trackedNotify(env, business.id, 'sms', () => sendSms(env, p, res.phone,
        bookingSms({ lang: res.lang, businessName: p.business_name, serviceName, date: res.date, time: fmtHHMM(res.start), id: res.id }))));
    }
    return json({ ok: true, booking: bookingView(p, await getBooking(env, business.id, res.id)) }, 201);
  }

  let m = /^\/api\/bookings\/([A-Z0-9]{4,12})\/(cancel|move)$/.exec(path);
  if (m && method === 'POST') {
    const old = await getBooking(env, business.id, m[1]);
    if (!old || old.status !== 'confirmed') return err('not_found', 404);
    const b = await body(request);
    const lang = old.language === 'fa' ? 'fa' : 'en';
    if (m[2] === 'cancel') {
      await cancelBooking(env, business, old.id);
      if (b.notify && old.customer_phone && p.sms_enabled) {
        ctx.waitUntil(trackedNotify(env, business.id, 'sms', () => sendSms(env, p, old.customer_phone,
          cancelSms({ lang, businessName: p.business_name, date: old.date, time: fmtHHMM(old.start_min), id: old.id }))));
      }
    } else {
      const res = await moveBooking(env, business, old, b.date, b.time, { minNoticeMinutes: 0 });
      if (!res.ok) return err(res.error, res.error === 'slot_taken' ? 409 : 400);
      if (b.notify && old.customer_phone && p.sms_enabled) {
        const serviceName = lang === 'fa' ? res.service.name_fa : res.service.name_en;
        ctx.waitUntil(trackedNotify(env, business.id, 'sms', () => sendSms(env, p, old.customer_phone,
          bookingSms({ lang, businessName: p.business_name, serviceName, date: res.date, time: fmtHHMM(res.start), id: old.id }))));
      }
    }
    return json({ ok: true, booking: bookingView(p, await getBooking(env, business.id, old.id)) });
  }

  if (path === '/api/calls' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 100);
    const before = url.searchParams.get('before') || '9999';
    const r = await env.DB.prepare(
      'SELECT conversation_id, caller, duration_secs, summary, success, data_json, created_at FROM calls WHERE business_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?'
    ).bind(business.id, before, limit).all();
    return json({ ok: true, calls: (r.results || []).map(callView) });
  }

  m = /^\/api\/calls\/([A-Za-z0-9_-]{1,100})(\/audio)?$/.exec(path);
  if (m && method === 'GET') {
    const c = await env.DB.prepare('SELECT * FROM calls WHERE conversation_id = ? AND business_id = ?').bind(m[1], business.id).first();
    if (!c) return err('not_found', 404);
    if (m[2]) return callAudio(env, c.conversation_id);
    let transcript = null;
    try { transcript = c.transcript_json ? JSON.parse(c.transcript_json).map(t => ({ role: t.role, message: t.message })).filter(t => t.message) : null; } catch { /* malformed */ }
    return json({ ok: true, call: { ...callView(c), transcript, audio: !!env.ELEVENLABS_API_KEY } });
  }

  if (path === '/api/messages' && method === 'GET') {
    const all = url.searchParams.get('status') === 'all';
    const r = await env.DB.prepare(
      `SELECT * FROM messages WHERE business_id = ? ${all ? '' : 'AND done_at IS NULL'} ORDER BY created_at DESC LIMIT 100`
    ).bind(business.id).all();
    return json({ ok: true, messages: r.results || [] });
  }

  m = /^\/api\/messages\/(\d+)\/done$/.exec(path);
  if (m && method === 'POST') {
    const b = await body(request);
    const r = await env.DB.prepare('UPDATE messages SET done_at = ? WHERE id = ? AND business_id = ?')
      .bind(b.done === false ? null : new Date().toISOString(), Number(m[1]), business.id).run();
    return r.meta?.changes === 1 ? json({ ok: true }) : err('not_found', 404);
  }

  if (path === '/api/settings' && method === 'GET') {
    return json({ ok: true, settings: settingsOf(p), needs_sync: business.needs_sync, can_edit: canManage(user) });
  }
  if (path === '/api/settings' && method === 'PUT') {
    if (!canManage(user)) return err('forbidden', 403);
    const edits = await body(request);
    const errors = validateSettings(edits);
    if (errors.length) return err('invalid', 400, { errors });
    const next = applySettings(p, edits);
    await env.DB.prepare("UPDATE businesses SET profile_json = ?, needs_sync = 1, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(next), business.id).run();
    return json({ ok: true, settings: settingsOf(next), needs_sync: true });
  }

  if (path === '/api/account' && method === 'GET') {
    const users = canManage(user)
      ? ((await env.DB.prepare('SELECT * FROM users WHERE business_id = ? ORDER BY id').bind(business.id).all()).results || []).map(publicUser)
      : [];
    return json({ ok: true, usage: await usageForPanel(env, business), users, billing_portal: null });
  }

  if (path === '/api/users' && method === 'POST') {
    if (!canManage(user)) return err('forbidden', 403);
    const b = await body(request);
    const name = String(b.name || '').trim().slice(0, 80);
    const phone = b.phone ? normalizePhone(b.phone) : null;
    const email = b.email ? parseIdentifier(b.email)?.value : null;
    const role = b.role === 'owner' ? 'owner' : 'staff';
    if (!name || (b.phone && !phone) || (b.email && (!email || !email.includes('@'))) || (!phone && !email)) return err('invalid');
    try {
      const r = await env.DB.prepare(
        "INSERT INTO users (business_id, name, phone, email, role, created_at) VALUES (?, ?, ?, ?, ?, datetime('now')) RETURNING *"
      ).bind(business.id, name, phone, email, role).first();
      return json({ ok: true, user: publicUser(r) }, 201);
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) return err('exists', 409);
      throw e;
    }
  }

  m = /^\/api\/users\/(\d+)$/.exec(path);
  if (m && method === 'DELETE') {
    if (!canManage(user)) return err('forbidden', 403);
    if (Number(m[1]) === user.id) return err('cannot_remove_self');
    const r = await env.DB.prepare('DELETE FROM users WHERE id = ? AND business_id = ?').bind(Number(m[1]), business.id).run();
    return r.meta?.changes === 1 ? json({ ok: true }) : err('not_found', 404);
  }

  return err('not_found', 404);
}

// Recording through our Worker, so the ElevenLabs key never reaches the browser.
// GET /v1/convai/conversations/{id}/audio (path from the official elevenlabs-js SDK).
async function callAudio(env, conversationId) {
  if (!env.ELEVENLABS_API_KEY) return err('not_configured', 404);
  const r = await fetch(`${(env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/$/, '')}/v1/convai/conversations/${encodeURIComponent(conversationId)}/audio`, {
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
  });
  if (!r.ok) return err('audio_unavailable', 404);
  return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'audio/mpeg', 'cache-control': 'private, no-store' } });
}
