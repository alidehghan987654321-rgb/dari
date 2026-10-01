// Pure helpers: time, slots, phone numbers, formatting, signatures.
// No I/O here so everything is unit-testable with `node --test`.

export const TZ = 'Europe/London';
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ---------- time ----------

/** Current UK local date, minutes since midnight and weekday. */
export function londonNow(now = new Date(), tz = TZ) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday: weekdayOf(date) };
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function daysBetween(a, b) {
  const t = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 864e5);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(toLatinDigits(s.trim()));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function fmtHHMM(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// ---------- slots ----------

/**
 * Free start times for a service on a date.
 * bookings: confirmed bookings on that date [{start_min, end_min, id?}]
 * Returns { ok, slots: ['HH:MM'], reason? }.
 * Capacity check is conservative: a slot is free if fewer than `capacity` bookings overlap it.
 */
export function computeSlots({ profile, service, date, bookings = [], now = new Date(), excludeId = null, minNoticeMinutes = null }) {
  if (!isValidDate(date)) return { ok: false, reason: 'bad_date' };
  const today = londonNow(now, profile.timezone || TZ);
  const ahead = daysBetween(today.date, date);
  if (ahead < 0) return { ok: false, reason: 'past_date' };
  if (ahead > (profile.max_days_ahead ?? 30)) return { ok: false, reason: 'too_far' };
  if ((profile.closed_dates || []).includes(date)) return { ok: false, reason: 'closed' };
  const ranges = (profile.opening_hours || {})[weekdayOf(date)] || [];
  if (!ranges.length) return { ok: false, reason: 'closed' };

  const step = profile.slot_step_minutes || 15;
  const capacity = profile.capacity || 1;
  // minNoticeMinutes overrides the profile (the owner panel uses 0: staff can book a walk-in for the next slot).
  const notice = minNoticeMinutes ?? profile.min_notice_minutes ?? 60;
  const minStart = ahead === 0 ? today.minutes + notice : -1;
  const live = bookings.filter(b => b.id !== excludeId);
  const slots = [];
  for (const [open, close] of ranges) {
    const o = parseHHMM(open), c = parseHHMM(close);
    for (let s = o; s + service.duration_min <= c; s += step) {
      if (s < minStart) continue;
      const e = s + service.duration_min;
      const overlapping = live.filter(b => b.start_min < e && b.end_min > s).length;
      if (overlapping < capacity) slots.push(fmtHHMM(s));
    }
  }
  return { ok: true, slots };
}

/** Sort slots by distance to a preferred time (keeps all), stable for ties. */
export function sortByPreferred(slots, preferred) {
  const p = parseHHMM(preferred || '');
  if (p == null) return slots;
  return [...slots].sort((a, b) => Math.abs(parseHHMM(a) - p) - Math.abs(parseHHMM(b) - p) || parseHHMM(a) - parseHHMM(b));
}

// ---------- phone numbers ----------

export function toLatinDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/** Normalise to E.164. UK numbers without a country code are assumed. Returns null if invalid. */
export function normalizePhone(input) {
  if (!input) return null;
  let s = toLatinDigits(input).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^0\d{10}$/.test(s)) s = '+44' + s.slice(1);          // 07700 900000 -> +447700900000
  else if (/^44\d{10}$/.test(s)) s = '+' + s;
  else if (/^\+440\d{10}$/.test(s)) s = '+44' + s.slice(4);  // +44 (0)7700...
  if (!/^\+\d{10,15}$/.test(s)) return null;
  return s;
}

export function isUkMobile(e164) {
  return /^\+447\d{9}$/.test(e164 || '');
}

// ---------- ids & auth ----------

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: easy to read out on the phone
export function bookingId(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ElevenLabs post-call webhook signature: header "t=<unix>,v0=<hex hmac of `${t}.${body}`>".
 * Check the exact scheme in the ElevenLabs dashboard docs when you enable the webhook.
 */
export async function verifyElevenLabsSignature(secret, header, rawBody, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 1800) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=').map(x => x.trim())));
  const t = Number(parts.t);
  if (!t || !parts.v0 || Math.abs(nowSec - t) > toleranceSec) return false;
  return safeEqual(await hmacHex(secret, `${t}.${rawBody}`), parts.v0);
}

// ---------- formatting for SMS / Telegram ----------

const FA_WEEKDAY = { sat: 'شنبه', sun: 'یکشنبه', mon: 'دوشنبه', tue: 'سه‌شنبه', wed: 'چهارشنبه', thu: 'پنجشنبه', fri: 'جمعه' };
const FA_MONTH = ['ژانویه', 'فوریه', 'مارس', 'آوریل', 'مه', 'ژوئن', 'ژوئیه', 'اوت', 'سپتامبر', 'اکتبر', 'نوامبر', 'دسامبر'];
const EN_WEEKDAY = { sat: 'Sat', sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri' };
const EN_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function toFaDigits(s) {
  return String(s).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

export function formatDate(dateStr, lang) {
  const [, m, d] = dateStr.split('-').map(Number);
  const wd = weekdayOf(dateStr);
  return lang === 'fa'
    ? `${FA_WEEKDAY[wd]} ${toFaDigits(d)} ${FA_MONTH.at(m - 1)}`
    : `${EN_WEEKDAY[wd]} ${d} ${EN_MONTH.at(m - 1)}`;
}

export function bookingSms({ lang, businessName, serviceName, date, time, id, address }) {
  // Kept short on purpose: SMS is billed per segment. Persian (UCS-2) target ≤ 2 segments, English ≤ 1.
  // Service name and address are left out (the caller already heard them); add them back per business if wanted.
  if (lang === 'fa') {
    return `${businessName}: نوبت ${id} ثبت شد، ${formatDate(date, 'fa')} ساعت ${toFaDigits(time)}. برای تغییر با ما تماس بگیرید.`;
  }
  return `${businessName}: booking ${id} confirmed, ${formatDate(date, 'en')} at ${time}. To change it, call us.`;
}

/** Number of SMS segments (GSM-7: 160/153, otherwise UCS-2: 70/67). Approximate: ignores GSM extended chars. */
export function smsSegments(text) {
  const gsm = /^[\x0A\x0D\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉÄÖÑÜ§¿äöñüà]*$/.test(text);
  const len = [...text].length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return len <= single ? 1 : Math.ceil(len / multi);
}

export function cancelSms({ lang, businessName, date, time, id }) {
  return lang === 'fa'
    ? `${businessName}: نوبت ${id} برای ${formatDate(date, 'fa')} ساعت ${toFaDigits(time)} لغو شد.`
    : `${businessName}: booking ${id} on ${formatDate(date, 'en')} at ${time} has been cancelled.`;
}
