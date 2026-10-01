// Business profile: the fields owners may edit in the panel, and validation. Pure, so the same rules can be
// reused by the onboarding wizard (M8) and unit-tested.

import { parseHHMM, isValidDate, normalizePhone } from './lib.js';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const EDITABLE = ['opening_hours', 'closed_dates', 'services', 'capacity', 'policies', 'faq', 'phone_for_transfer', 'transfer_hours'];

const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Returns a list of { field, error } (empty = valid). Validates only the editable fields present. */
export function validateSettings(s) {
  const errors = [];
  const err = (field, error) => errors.push({ field, error });

  if ('opening_hours' in s) {
    const oh = s.opening_hours;
    if (!oh || typeof oh !== 'object' || Array.isArray(oh)) err('opening_hours', 'invalid');
    else {
      for (const k of Object.keys(oh)) if (!DAYS.includes(k)) err(`opening_hours.${k}`, 'unknown_day');
      for (const d of DAYS) {
        const ranges = oh[d] ?? [];
        if (!Array.isArray(ranges) || ranges.length > 4) { err(`opening_hours.${d}`, 'invalid'); continue; }
        const mins = ranges.map(r => (Array.isArray(r) && r.length === 2 ? [parseHHMM(r[0]), parseHHMM(r[1])] : [null, null]));
        if (mins.some(([o, c]) => o == null || c == null || o >= c)) { err(`opening_hours.${d}`, 'bad_range'); continue; }
        const sorted = [...mins].sort((a, b) => a[0] - b[0]);
        if (sorted.some((r, i) => i > 0 && r[0] < sorted[i - 1][1])) err(`opening_hours.${d}`, 'overlap');
      }
    }
  }
  if ('closed_dates' in s) {
    if (!Array.isArray(s.closed_dates) || s.closed_dates.length > 200 || !s.closed_dates.every(isValidDate)) err('closed_dates', 'invalid');
  }
  if ('services' in s) {
    const list = s.services;
    if (!Array.isArray(list) || !list.length || list.length > 50) err('services', 'invalid');
    else {
      const ids = new Set();
      list.forEach((x, i) => {
        const f = `services.${i}`;
        if (!x || typeof x !== 'object') return err(f, 'invalid');
        if (typeof x.id !== 'string' || !/^[a-z0-9-]{2,40}$/.test(x.id)) err(`${f}.id`, 'invalid');
        else if (ids.has(x.id)) err(`${f}.id`, 'duplicate');
        ids.add(x.id);
        if (!str(x.name_en, 80)) err(`${f}.name_en`, 'required');
        if (!str(x.name_fa, 80)) err(`${f}.name_fa`, 'required');
        if (!Number.isInteger(x.duration_min) || x.duration_min < 5 || x.duration_min > 480) err(`${f}.duration_min`, 'invalid');
        const price = x.price ?? x.price_gbp;
        if (typeof price !== 'number' || !(price >= 0) || price > 10000) err(`${f}.price`, 'invalid');
      });
    }
  }
  if ('capacity' in s && (!Number.isInteger(s.capacity) || s.capacity < 1 || s.capacity > 20)) err('capacity', 'invalid');
  if ('policies' in s && (!Array.isArray(s.policies) || s.policies.length > 30 || !s.policies.every(p => str(p, 300)))) err('policies', 'invalid');
  if ('faq' in s && (!Array.isArray(s.faq) || s.faq.length > 50 || !s.faq.every(f => f && str(f.q, 300) && str(f.a, 300)))) err('faq', 'invalid');
  if ('phone_for_transfer' in s && s.phone_for_transfer && !normalizePhone(s.phone_for_transfer)) err('phone_for_transfer', 'invalid');
  if ('transfer_hours' in s && s.transfer_hours && !str(s.transfer_hours, 200)) err('transfer_hours', 'invalid');
  return errors;
}

/** Editable subset of a profile, as the panel shows it. Prices always as `price`. */
export function settingsOf(profile) {
  const out = {};
  for (const k of EDITABLE) out[k] = profile[k] ?? null;
  out.services = (profile.services || []).map(s => ({ ...s, price: s.price ?? s.price_gbp, price_gbp: undefined }));
  out.currency = profile.currency || 'GBP';
  return out;
}

/** Merge validated edits into a profile. Only editable keys are taken; everything else stays as it was. */
export function applySettings(profile, edits) {
  const next = { ...profile };
  for (const k of EDITABLE) if (k in edits) next[k] = edits[k];
  if ('services' in edits) {
    next.services = edits.services.map(s => ({
      id: s.id, name_en: s.name_en.trim(), name_fa: s.name_fa.trim(), duration_min: s.duration_min, price: s.price ?? s.price_gbp,
    }));
  }
  if ('phone_for_transfer' in edits) next.phone_for_transfer = edits.phone_for_transfer ? normalizePhone(edits.phone_for_transfer) : '';
  return next;
}
