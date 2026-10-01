// The QA clock. Every run simulates a call on the next Wednesday (at least one day ahead of the real date)
// at 10:30 business time, so "tomorrow" is always Thursday and every date the scenarios use stays inside
// the Worker's booking window, which is measured from the real date.

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function localDate(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** First date strictly after `dateStr` that falls on weekday `wd`. */
export function nextWeekday(dateStr, wd) {
  for (let i = 1; i <= 7; i++) if (weekdayOf(addDays(dateStr, i)) === wd) return addDays(dateStr, i);
  throw new Error(`bad weekday ${wd}`);
}

/** UTC instant of a local wall-clock time in `tz` (handles BST/GMT and other offsets). */
export function zonedToUtc(dateStr, hhmm, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (shown - guess));
}

/** The simulated date for a run: next Wednesday after the real local date. */
export function qaToday(realNow = new Date(), tz = 'Europe/London') {
  return nextWeekday(localDate(realNow, tz), 'wed');
}

/** Simulated "now" for one case. `clock` may override the local time, e.g. { time: '23:00' }. */
export function qaNow(today, tz, clock = {}) {
  return zonedToUtc(today, clock.time || '10:30', tz);
}

/**
 * Resolve a date expression relative to the QA date:
 *   $today  $tomorrow  $plus(3)  $next(sat)
 * Anything else is returned unchanged.
 */
export function resolveDate(expr, today) {
  if (typeof expr !== 'string' || !expr.startsWith('$')) return expr;
  if (expr === '$today') return today;
  if (expr === '$tomorrow') return addDays(today, 1);
  let m = /^\$plus\((\d+)\)$/.exec(expr);
  if (m) return addDays(today, Number(m[1]));
  m = /^\$next\((mon|tue|wed|thu|fri|sat|sun)\)$/.exec(expr);
  if (m) return nextWeekday(today, m[1]);
  return expr;
}
