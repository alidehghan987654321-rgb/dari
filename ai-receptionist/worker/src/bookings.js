// Booking core shared by the voice agent's tools and the owner panel (one implementation of the rules).
// Every write re-checks the slot with computeSlots and is atomic against capacity in SQL, so two callers,
// or a caller and a member of staff, can never overbook.
// Failures are { ok: false, error, message_for_agent } — the agent reads the message, the panel the code.

import { computeSlots, sortByPreferred, parseHHMM, fmtHHMM, isValidDate, normalizePhone, bookingId } from './lib.js';

export const fail = (error, message_for_agent) => ({ ok: false, error, message_for_agent });

export const REASON_TEXT = {
  bad_date: 'The date is not valid. Ask the caller for the day again.',
  past_date: 'That date is in the past. Ask for a future day.',
  too_far: 'That date is too far ahead for bookings. Offer a closer date.',
  closed: 'The business is closed on that day. Tell the caller and offer the nearest open day.',
};

export async function loadBusiness(env, id) {
  const row = await env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(id).first();
  if (!row) return null;
  const profile = JSON.parse(row.profile_json);
  // Message-only mode is set by the usage rules (M4), not by the owner; the prompt renderer reads it from the profile.
  if (row.message_only) profile.message_only = true;
  return {
    id: row.id, agent_id: row.agent_id, active: !!row.active, needs_sync: !!row.needs_sync,
    message_only: !!row.message_only, message_only_reason: row.message_only_reason ?? null, profile,
  };
}

export function findService(profile, id) {
  return (profile.services || []).find(s => s.id === id);
}

export async function bookingsOn(env, businessId, date) {
  const r = await env.DB.prepare(
    "SELECT id, start_min, end_min FROM bookings WHERE business_id = ? AND date = ? AND status = 'confirmed'"
  ).bind(businessId, date).all();
  return r.results || [];
}

/** Free start times, closest to `preferred_time` first. */
export async function freeSlots(env, business, { service_id, date, preferred_time, excludeId = null, minNoticeMinutes = null }) {
  const p = business.profile;
  const service = findService(p, service_id);
  if (!service) return { ...fail('unknown_service', `Unknown service. Valid ids: ${(p.services || []).map(s => s.id).join(', ')}.`) };
  const res = computeSlots({ profile: p, service, date, bookings: isValidDate(date) ? await bookingsOn(env, business.id, date) : [], excludeId, minNoticeMinutes });
  if (!res.ok) return fail(res.reason, REASON_TEXT[res.reason]);
  return { ok: true, service, slots: sortByPreferred(res.slots, preferred_time) };
}

/**
 * Create a booking. input: { service_id, date, time, customer_name, customer_phone, language, notes }.
 * opts: { source: 'phone_ai' | 'panel', requirePhone, minNoticeMinutes, dryRun }
 */
export async function createBooking(env, business, input, { source = 'phone_ai', requirePhone = true, minNoticeMinutes = null, dryRun = false } = {}) {
  const p = business.profile;
  const service = findService(p, input.service_id);
  if (!service) return fail('unknown_service', 'Unknown service id. Check the business facts.');
  const phone = normalizePhone(input.customer_phone);
  if (!phone && (requirePhone || input.customer_phone)) return fail('bad_phone', 'The phone number looks wrong. Ask for it again, digit by digit.');
  const name = String(input.customer_name || '').trim().slice(0, 80);
  if (!name) return fail('missing_name', 'Ask for the caller\'s name.');
  const start = parseHHMM(input.time);
  if (!isValidDate(input.date) || start == null) return fail('bad_time', 'Date or time is not valid. Check availability again.');

  const check = computeSlots({ profile: p, service, date: input.date, bookings: await bookingsOn(env, business.id, input.date), minNoticeMinutes });
  if (!check.ok) return fail(check.reason, REASON_TEXT[check.reason]);
  if (!check.slots.includes(fmtHHMM(start))) {
    return fail('slot_taken', `That time is no longer free. Nearest free times: ${sortByPreferred(check.slots, input.time).slice(0, 3).join(', ') || 'none that day'}.`);
  }
  const lang = input.language === 'fa' ? 'fa' : 'en';
  if (dryRun) return { ok: true, dry_run: true, service, date: input.date, start, lang };

  const id = bookingId();
  const end = start + service.duration_min;
  // Atomic insert: only succeeds if overlap count is still below capacity (guards two simultaneous calls).
  const res = await env.DB.prepare(
    `INSERT INTO bookings (id, business_id, service_id, date, start_min, end_min, customer_name, customer_phone, language, notes, status, source, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, datetime('now')
     WHERE (SELECT COUNT(*) FROM bookings WHERE business_id = ? AND date = ? AND status = 'confirmed' AND start_min < ? AND end_min > ?) < ?`
  ).bind(id, business.id, service.id, input.date, start, end, name, phone || '', lang, String(input.notes || '').slice(0, 300), source,
    business.id, input.date, end, start, p.capacity || 1).run();
  if (!res.meta || res.meta.changes !== 1) return fail('slot_taken', 'That time was just taken. Check availability again and offer another time.');
  return { ok: true, id, service, date: input.date, start, end, name, phone, lang };
}

/** Move a confirmed booking (row from the bookings table) to a new date/time. */
export async function moveBooking(env, business, old, newDate, newTime, { minNoticeMinutes = null } = {}) {
  const p = business.profile;
  const start = parseHHMM(newTime);
  if (!isValidDate(newDate) || start == null) return fail('bad_input', 'Check the phone number, new date and new time.');
  const service = findService(p, old.service_id);
  if (!service) return fail('unknown_service', 'This service no longer exists. Take a message for the team.');
  const check = computeSlots({ profile: p, service, date: newDate, bookings: await bookingsOn(env, business.id, newDate), excludeId: old.id, minNoticeMinutes });
  if (!check.ok) return fail(check.reason, REASON_TEXT[check.reason]);
  if (!check.slots.includes(fmtHHMM(start))) return fail('slot_taken', `Not free. Nearest: ${sortByPreferred(check.slots, newTime).slice(0, 3).join(', ') || 'none that day'}.`);
  const end = start + service.duration_min;
  const res = await env.DB.prepare(
    `UPDATE bookings SET date = ?, start_min = ?, end_min = ?, updated_at = datetime('now')
     WHERE id = ? AND business_id = ? AND status = 'confirmed'
       AND (SELECT COUNT(*) FROM bookings WHERE business_id = ? AND date = ? AND status = 'confirmed' AND id != ? AND start_min < ? AND end_min > ?) < ?`
  ).bind(newDate, start, end, old.id, business.id, business.id, newDate, old.id, end, start, p.capacity || 1).run();
  if (!res.meta || res.meta.changes !== 1) return fail('slot_taken', 'That time was just taken. Check availability again.');
  return { ok: true, id: old.id, service, date: newDate, start };
}

export async function cancelBooking(env, business, id) {
  const res = await env.DB.prepare(
    "UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND business_id = ? AND status = 'confirmed'"
  ).bind(id, business.id).run();
  return res.meta?.changes === 1 ? { ok: true, id } : fail('not_found', 'Booking not found.');
}

export async function getBooking(env, businessId, id) {
  return env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND business_id = ?').bind(id, businessId).first();
}
