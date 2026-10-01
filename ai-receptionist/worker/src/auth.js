// M3 — passwordless login for the owner panel: 6-digit code by SMS or email -> 30-day session cookie.
// Codes and session tokens are stored only as HMAC-SHA256 (keyed by SESSION_SECRET), so a database
// leak does not reveal live codes or sessions.

import { normalizePhone, safeEqual } from './lib.js';

export const CODE_TTL_MIN = 10;
export const CODE_MAX_TRIES = 5;
export const SESSION_DAYS = 30;
export const COOKIE = 'sid';
// Login code requests: per phone/email and per IP.
export const LIMITS = { identifier: { max: 3, windowSec: 15 * 60 }, ip: { max: 20, windowSec: 60 * 60 } };

const enc = new TextEncoder();

async function hmac(secret, msg) {
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

/** Uniform 6-digit code (rejection sampling, no modulo bias). */
export function generateCode() {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_294_000_000) return String(buf[0] % 1_000_000).padStart(6, '0');
  }
}

export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** { kind: 'email' | 'phone', value } or null. Phone uses the business country's rules (UK in v1). */
export function parseIdentifier(input) {
  const s = String(input || '').trim();
  if (s.includes('@')) {
    const email = s.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? { kind: 'email', value: email } : null;
  }
  const phone = normalizePhone(s);
  return phone ? { kind: 'phone', value: phone } : null;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeSec = SESSION_DAYS * 86400) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

/** Fixed-window rate limit. Returns true if this request is allowed (and counts it). */
export async function rateLimit(env, key, { max, windowSec }, nowSec = Math.floor(Date.now() / 1000)) {
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END
     RETURNING count`
  ).bind(key, nowSec, nowSec - windowSec, nowSec - windowSec).first();
  return row.count <= max;
}

export async function findUserByIdentifier(env, id) {
  const col = id.kind === 'email' ? 'email' : 'phone';
  return env.DB.prepare(`SELECT * FROM users WHERE ${col} = ?`).bind(id.value).first();
}

/** Store a new code for the user (older unused codes stop working) and return it in clear for sending. */
export async function issueCode(env, user, now = new Date()) {
  const code = generateCode();
  await env.DB.batch([
    env.DB.prepare('UPDATE login_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now.toISOString(), user.id),
    env.DB.prepare('INSERT INTO login_codes (user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(user.id, await hmac(env.SESSION_SECRET, `code:${user.id}:${code}`), new Date(+now + CODE_TTL_MIN * 60_000).toISOString(), now.toISOString()),
  ]);
  return code;
}

/**
 * Check a code. Returns { ok: true } or { ok: false, error: 'bad_code' | 'expired' | 'too_many_attempts' }.
 * A wrong guess burns one of the code's five tries.
 */
export async function checkCode(env, user, code, now = new Date()) {
  const row = await env.DB.prepare(
    'SELECT * FROM login_codes WHERE user_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1'
  ).bind(user.id).first();
  if (!row || row.expires_at <= now.toISOString()) return { ok: false, error: 'expired' };
  if (row.attempts >= CODE_MAX_TRIES) return { ok: false, error: 'too_many_attempts' };
  const expected = await hmac(env.SESSION_SECRET, `code:${user.id}:${String(code || '').trim()}`);
  if (!safeEqual(expected, row.code_hash)) {
    await env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
    return { ok: false, error: row.attempts + 1 >= CODE_MAX_TRIES ? 'too_many_attempts' : 'bad_code' };
  }
  await env.DB.prepare('UPDATE login_codes SET used_at = ? WHERE id = ?').bind(now.toISOString(), row.id).run();
  return { ok: true };
}

export async function createSession(env, user, now = new Date()) {
  const token = generateToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await hmac(env.SESSION_SECRET, `session:${token}`), user.id, now.toISOString(), new Date(+now + SESSION_DAYS * 864e5).toISOString()),
    env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now.toISOString(), user.id),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now.toISOString()),
  ]);
  return token;
}

/** The logged-in user for this request, or null. */
export async function sessionUser(env, request, now = new Date()) {
  const token = parseCookies(request.headers.get('cookie'))[COOKIE];
  if (!token || token.length > 100) return null;
  const hash = await hmac(env.SESSION_SECRET, `session:${token}`);
  const user = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(hash, now.toISOString()).first();
  return user ? { ...user, tokenHash: hash } : null;
}

export async function endSession(env, user) {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.tokenHash).run();
}

/**
 * Which business a request acts on. Owners and staff: always their own (asking for another is refused).
 * Superadmin: the one they chose (x-business-id header or ?b=). Pure.
 * Returns { ok: true, businessId } or { ok: false, status, error }.
 */
export function resolveBusiness(user, requested) {
  if (user.role === 'superadmin') {
    return requested ? { ok: true, businessId: requested } : { ok: false, status: 400, error: 'choose_business' };
  }
  if (requested && requested !== user.business_id) return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, businessId: user.business_id };
}

/** Owners (and our team) manage settings and users; staff work the diary. */
export const canManage = user => user.role === 'owner' || user.role === 'superadmin';
