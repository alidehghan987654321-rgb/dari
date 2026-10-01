// Deterministic judge: no LLM involved. Pure functions only, so they are unit-tested.
import { resolveDate } from './clock.mjs';

// ---------- text helpers ----------

export function toLatinDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/** Share of letters that are Arabic-script (Persian). Null if the text has no letters. */
export function persianRatio(text) {
  const letters = String(text).match(/\p{L}/gu) || [];
  if (!letters.length) return null;
  return letters.filter(c => /[؀-ۿﭐ-﷿ﹰ-﻿]/.test(c)).length / letters.length;
}

export function languageOf(text) {
  const r = persianRatio(text);
  if (r == null) return null;
  return r >= 0.5 ? 'fa' : r <= 0.2 ? 'en' : 'mixed';
}

const EN_NUM = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const FA_NUM = {
  'یک': 1, 'یه': 1, 'دو': 2, 'سه': 3, 'چهار': 4, 'پنج': 5, 'شش': 6, 'شیش': 6, 'هفت': 7, 'هشت': 8, 'نه': 9, 'ده': 10,
  'یازده': 11, 'دوازده': 12, 'سیزده': 13, 'چهارده': 14, 'پانزده': 15, 'پونزده': 15, 'شانزده': 16, 'شونزده': 16,
  'هفده': 17, 'هیفده': 17, 'هجده': 18, 'هیجده': 18, 'نوزده': 19, 'بیست': 20, 'سی': 30, 'چهل': 40, 'پنجاه': 50,
  'شصت': 60, 'هفتاد': 70, 'هشتاد': 80, 'نود': 90, 'صد': 100, 'یکصد': 100, 'دویست': 200, 'سیصد': 300,
  'چهارصد': 400, 'پانصد': 500, 'پونصد': 500,
};

function wordsToNumber(words, table) {
  let total = 0;
  for (const w of words) {
    const v = table[w];
    if (v == null) continue;
    if (v === 100 && w === 'hundred') total = (total || 1) * 100;
    else total += v;
  }
  return total;
}

const EN_WORD = Object.keys(EN_NUM).join('|');
const FA_WORD = Object.keys(FA_NUM).sort((a, b) => b.length - a.length).join('|');

/** Money amounts mentioned in a text: "£20", "20 pounds", "twenty-eight pounds", "۲۰ پوند", "بیست و هشت پوند". */
export function findPrices(text) {
  const t = toLatinDigits(text);
  const out = [];
  for (const m of t.matchAll(/£\s?(\d+(?:\.\d{1,2})?)/g)) out.push(Number(m[1]));
  for (const m of t.matchAll(/(\d+(?:\.\d{1,2})?)\s*(?:pounds?\b|quid\b|gbp\b|پوند)/giu)) out.push(Number(m[1]));
  for (const m of t.matchAll(new RegExp(`((?:\\b(?:${EN_WORD})\\b[\\s-]*(?:and\\s+)?)+)pounds?\\b`, 'gi'))) {
    out.push(wordsToNumber(m[1].toLowerCase().split(/[\s-]+/), EN_NUM));
  }
  for (const m of t.matchAll(new RegExp(`(?<!\\p{L})((?:(?:${FA_WORD})(?:\\s+و\\s+|\\s+))+)پوند`, 'gu'))) {
    out.push(wordsToNumber(m[1].split(/\s+/), FA_NUM));
  }
  return out.filter(n => n > 0);
}

// ---------- matching ----------

function toRegex(s) {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(s);
  return m ? new RegExp(m[1], m[2].includes('u') ? m[2] : `${m[2]}u`) : null;
}

/** Resolve $fixture(n) and date tokens in an expected value. */
export function resolveExpected(value, ctx) {
  if (typeof value !== 'string') return value;
  const f = /^\$fixture\((\d+)\)$/.exec(value);
  if (f) return ctx.fixtures?.[Number(f[1])]?.id ?? value;
  return resolveDate(value, ctx.today);
}

/** Does an actual tool argument satisfy an expected matcher (exact, case-insensitive, or /regex/)? */
export function argMatches(expected, actual, ctx) {
  if (actual == null) return false;
  const exp = resolveExpected(expected, ctx);
  const raw = String(actual);
  const compact = toLatinDigits(raw).replace(/[\s\-().]/g, '');
  const re = typeof exp === 'string' ? toRegex(exp) : null;
  if (re) return re.test(raw) || re.test(compact) || re.test(toLatinDigits(raw));
  return String(exp).trim().toLowerCase() === toLatinDigits(raw).trim().toLowerCase();
}

function callMatches(spec, call, ctx) {
  if (spec.tool !== call.name) return false;
  return Object.entries(spec.args || {}).every(([k, v]) => argMatches(v, call.input?.[k], ctx));
}

function describe(spec, ctx) {
  const args = Object.entries(spec.args || {}).map(([k, v]) => `${k}=${resolveExpected(v, ctx)}`).join(', ');
  return `${spec.tool}(${args})`;
}

// ---------- judge ----------

/**
 * caseDef: the scenario from scenarios.yaml.
 * run: { transcript, db: { bookings, messages }, fixtures: [{ id, date, time }] }
 * ctx: { today, allowedPrices: [numbers] }
 */
export function judgeCase(caseDef, run, ctx) {
  const c = { ...ctx, fixtures: run.fixtures };
  const failures = [];
  const invented = [];
  const calls = run.transcript.filter(e => e.role === 'tool');
  const agentTexts = run.transcript.slice(1).filter(e => e.role === 'agent').map(e => e.text);

  // Expected tools: ordered subsequence.
  let from = 0;
  for (const spec of caseDef.expected_tools || []) {
    const idx = calls.findIndex((call, i) => i >= from && callMatches(spec, call, c));
    if (idx < 0) {
      const sameName = calls.filter(x => x.name === spec.tool).map(x => JSON.stringify(x.input)).join('; ');
      failures.push(`expected ${describe(spec, c)}${sameName ? ` — got ${spec.tool} ${sameName}` : ' — not called'}`);
      break;
    }
    from = idx + 1;
  }
  for (const spec of caseDef.forbid_tools || []) {
    const hit = calls.find(call => callMatches(spec, call, c));
    if (hit) failures.push(`forbidden call ${describe(spec, c)}: ${JSON.stringify(hit.input)}`);
  }

  // Phrases.
  for (const item of caseDef.must_say || []) {
    const re = toRegex(item.re ?? item) || new RegExp(item.re ?? item, 'iu');
    if (!agentTexts.some(t => re.test(t) || re.test(toLatinDigits(t)))) failures.push(`never said ${re}`);
  }
  for (const item of caseDef.must_not_say || []) {
    const re = toRegex(item.re ?? item) || new RegExp(item.re ?? item, 'iu');
    const hit = agentTexts.find(t => re.test(t) || re.test(toLatinDigits(t)));
    if (hit) {
      failures.push(`said ${re}: "${hit.slice(0, 120)}"`);
      if (item.fact) invented.push(`${re}`);
    }
  }

  // Prices not in the profile are always invented facts.
  const allowed = new Set(ctx.allowedPrices || []);
  for (const t of agentTexts) {
    for (const p of findPrices(t)) {
      if (!allowed.has(p)) {
        invented.push(`price ${p}`);
        failures.push(`invented price ${p}: "${t.slice(0, 120)}"`);
      }
    }
  }

  // Reply language per caller turn.
  const callerCount = run.transcript.filter(e => e.role === 'caller').length;
  const langs = caseDef.reply_languages || Array(callerCount).fill(caseDef.language);
  let turn = -1;
  for (const e of run.transcript) {
    if (e.role === 'caller') { turn++; continue; }
    if (e.role !== 'agent' || turn < 0 || !langs[turn] || e.text.startsWith('[harness')) continue;
    const got = languageOf(e.text);
    if (got && got !== langs[turn] && !(got === 'mixed' && langs[turn] === 'fa')) {
      failures.push(`turn ${turn + 1}: expected ${langs[turn]} reply, got ${got}: "${e.text.slice(0, 80)}"`);
    }
  }

  // End state, from the database and the transcript.
  const fixtureIds = new Set(run.fixtures.map(f => f.id));
  const created = run.db.bookings.filter(b => !fixtureIds.has(b.id));
  const end = caseDef.end_state || {};
  if (end.booking === 'created' && !created.some(b => b.status === 'confirmed')) failures.push('end state: no booking was created');
  if (end.booking === 'none' && created.length) failures.push(`end state: unexpected booking ${created[0].id} at ${created[0].date} ${created[0].time}`);
  if (end.booking === 'cancelled') {
    const f = run.db.bookings.find(b => b.id === run.fixtures[0]?.id);
    if (f?.status !== 'cancelled') failures.push('end state: booking was not cancelled');
  }
  if (end.booking === 'moved') {
    const f = run.db.bookings.find(b => b.id === run.fixtures[0]?.id);
    if (!f || (f.date === run.fixtures[0].date && f.time === run.fixtures[0].time)) failures.push('end state: booking was not moved');
  }
  if (end.message === true && !run.db.messages.length) failures.push('end state: no message was taken');
  if (end.message === false && run.db.messages.length) failures.push('end state: unexpected message');
  const transferred = calls.some(x => x.name === 'transfer_to_number');
  if (end.transfer === true && !transferred) failures.push('end state: call was not transferred');
  if (end.transfer === false && transferred) failures.push('end state: call was transferred');

  return {
    id: caseDef.id,
    title: caseDef.title,
    tags: caseDef.tags || [],
    pass: failures.length === 0,
    failures,
    invented,
    agentTurns: agentTexts.length,
    bookingCreated: created.some(b => b.status === 'confirmed'),
    toolCalls: calls.map(x => x.name),
    excerpt: excerpt(run.transcript),
  };
}

function excerpt(transcript, max = 14) {
  return transcript.slice(0, max).map(e => e.role === 'tool'
    ? `  ⚙ ${e.name}(${JSON.stringify(e.input)}) → ${JSON.stringify(e.result).slice(0, 160)}`
    : `${e.role === 'agent' ? 'Agent' : 'Caller'}: ${e.text}`);
}

/** Overall numbers for the report and the Phase 1 gate. */
export function summarise(results) {
  const booking = results.filter(r => r.tags.includes('booking'));
  const booked = results.filter(r => r.bookingCreated);
  const invented = results.reduce((n, r) => n + r.invented.length, 0);
  const bookingAccuracy = booking.length ? booking.filter(r => r.pass).length / booking.length : null;
  return {
    cases: results.length,
    passed: results.filter(r => r.pass).length,
    bookingCases: booking.length,
    bookingAccuracy,
    inventedFacts: invented,
    avgTurnsPerBooking: booked.length ? booked.reduce((n, r) => n + r.agentTurns, 0) / booked.length : null,
    gate: { bookingAccuracyMin: 0.9, passed: bookingAccuracy != null && bookingAccuracy >= 0.9 && invented === 0 },
  };
}
