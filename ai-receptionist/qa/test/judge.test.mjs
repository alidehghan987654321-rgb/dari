import test from 'node:test';
import assert from 'node:assert/strict';
import { findPrices, languageOf, argMatches, judgeCase, summarise } from '../lib/judge.mjs';
import { qaToday, resolveDate, zonedToUtc, weekdayOf } from '../lib/clock.mjs';
import { mutate } from '../lib/mutations.mjs';
import { loadTemplate, render } from '../../scripts/prompt.mjs';
import { loadScenarios } from '../run.mjs';
import { loadTools } from '../lib/tools.mjs';

test('QA clock: next Wednesday, BST/GMT aware', () => {
  assert.equal(qaToday(new Date('2026-10-01T12:00:00Z')), '2026-10-07'); // Thu -> next Wed
  assert.equal(qaToday(new Date('2026-10-07T12:00:00Z')), '2026-10-14'); // Wed -> the following Wed
  assert.equal(weekdayOf(qaToday()), 'wed');
  assert.equal(zonedToUtc('2026-07-01', '10:30', 'Europe/London').toISOString(), '2026-07-01T09:30:00.000Z');
  assert.equal(zonedToUtc('2026-12-02', '10:30', 'Europe/London').toISOString(), '2026-12-02T10:30:00.000Z');
  assert.equal(resolveDate('$tomorrow', '2026-10-07'), '2026-10-08');
  assert.equal(resolveDate('$next(sat)', '2026-10-07'), '2026-10-10');
  assert.equal(resolveDate('$next(wed)', '2026-10-07'), '2026-10-14');
  assert.equal(resolveDate('2026-01-01', '2026-10-07'), '2026-01-01');
});

test('findPrices: digits, symbols and number words in English and Persian', () => {
  assert.deepEqual(findPrices('It is £20 for a cut'), [20]);
  assert.deepEqual(findPrices('That will be twenty-eight pounds.'), [28]);
  assert.deepEqual(findPrices('قیمتش چهارده پوند هست'), [14]);
  assert.deepEqual(findPrices('اصلاح مو و ریش بیست و هشت پوند'), [28]);
  assert.deepEqual(findPrices('حدود ۳۵ پوند'), [35]);
  assert.deepEqual(findPrices('Your booking is at 10:00 on Saturday'), []);
  assert.deepEqual(findPrices('ساعت چهار بعدازظهر'), []);
});

test('languageOf', () => {
  assert.equal(languageOf('سلام، بفرمایید'), 'fa');
  assert.equal(languageOf('یه appointment برای فردا دارید'), 'fa');
  assert.equal(languageOf('Lovely, let me check that for you.'), 'en');
  assert.equal(languageOf('10:00'), null);
});

test('argMatches: exact, regex, date tokens, Persian digits in phones', () => {
  const ctx = { today: '2026-10-07', fixtures: [{ id: 'K7QX2M' }] };
  assert.ok(argMatches('mens-cut', 'Mens-Cut', ctx));
  assert.ok(argMatches('$tomorrow', '2026-10-08', ctx));
  assert.ok(!argMatches('$tomorrow', '2026-10-09', ctx));
  assert.ok(argMatches('/7700900456$/', '۰۷۷۰۰ ۹۰۰ ۴۵۶', ctx));
  assert.ok(argMatches('/7700900456$/', '+44 7700 900456', ctx));
  assert.ok(argMatches('$fixture(0)', 'K7QX2M', ctx));
  assert.ok(argMatches('16:00', '۱۶:۰۰', ctx));
  assert.ok(!argMatches('16:00', undefined, ctx));
});

const base = { fixtures: [], db: { bookings: [], messages: [] } };
const ctx = { today: '2026-10-07', allowedPrices: [20, 28, 14, 10] };

test('judge: ordered expected tools and end state', () => {
  const c = {
    id: 'X', language: 'en', tags: ['booking'],
    expected_tools: [{ tool: 'check_availability', args: { date: '$tomorrow' } }, { tool: 'create_booking', args: { time: '16:00' } }],
    end_state: { booking: 'created' },
  };
  const transcript = [
    { role: 'agent', text: 'Hello' }, { role: 'caller', text: 'Hi' },
    { role: 'tool', name: 'check_availability', input: { date: '2026-10-08' }, result: { ok: true } },
    { role: 'agent', text: 'I have four o\'clock.' },
    { role: 'tool', name: 'create_booking', input: { time: '16:00' }, result: { ok: true } },
    { role: 'agent', text: 'Booked.' },
  ];
  const ok = judgeCase(c, { ...base, transcript, db: { bookings: [{ id: 'NEW', status: 'confirmed' }], messages: [] } }, ctx);
  assert.equal(ok.pass, true, ok.failures.join('; '));

  const wrongOrder = [transcript[0], transcript[1], transcript[4], transcript[2]];
  const r = judgeCase(c, { ...base, transcript: wrongOrder, db: { bookings: [], messages: [] } }, ctx);
  assert.equal(r.pass, false);
  assert.match(r.failures.join(), /create_booking/);
  assert.match(r.failures.join(), /no booking was created/);
});

test('judge: invented prices, must_say, forbidden tools, reply language', () => {
  const c = {
    id: 'Y', language: 'fa', must_say: ['/مطمئن نیستم/'], forbid_tools: [{ tool: 'create_booking' }],
  };
  const transcript = [
    { role: 'agent', text: 'Hello / سلام' }, { role: 'caller', text: 'رنگ مو چنده؟' },
    { role: 'agent', text: 'رنگ مو سی و پنج پوند هست.' },
    { role: 'caller', text: 'ok' },
    { role: 'agent', text: 'Anything else?' },
    { role: 'tool', name: 'create_booking', input: {}, result: { ok: true } },
  ];
  const r = judgeCase(c, { ...base, transcript }, ctx);
  assert.equal(r.pass, false);
  assert.deepEqual(r.invented, ['price 35']);
  assert.ok(r.failures.some(f => f.startsWith('never said')));
  assert.ok(r.failures.some(f => f.startsWith('forbidden call create_booking')));
  assert.ok(r.failures.some(f => /turn 2: expected fa reply, got en/.test(f)));
});

test('summarise: booking accuracy and gate', () => {
  const s = summarise([
    { id: 'a', tags: ['booking'], pass: true, invented: [], bookingCreated: true, agentTurns: 6 },
    { id: 'b', tags: ['booking'], pass: false, invented: [], bookingCreated: true, agentTurns: 8 },
    { id: 'c', tags: [], pass: true, invented: [], bookingCreated: false, agentTurns: 2 },
  ]);
  assert.equal(s.bookingAccuracy, 0.5);
  assert.equal(s.avgTurnsPerBooking, 7);
  assert.equal(s.gate.passed, false);
});

test('mutation removes the guardrails and fails loudly if the template drifts', () => {
  const t = loadTemplate();
  const m = mutate(t, 'no-invent-guard');
  assert.ok(t.includes('Never make up prices'));
  assert.ok(!m.includes('Never make up prices'));
  assert.ok(!m.includes('do not guess'));
  assert.throws(() => mutate('nothing here', 'no-invent-guard'), /no longer matches/);
});

test('message-only profiles render a "bookings paused" block (M4)', () => {
  const p = { business_name: 'X', business_type: 'barber', city: 'London', address: 'a', services: [], currency: 'GBP' };
  assert.ok(!render(loadTemplate(), p).includes('bookings by phone are paused'));
  assert.ok(render(loadTemplate(), { ...p, message_only: true }).includes('bookings by phone are paused'));
});

test('a profile completed in the onboarding wizard renders with no empty placeholders (M8)', async () => {
  const { draftProfile, validateProfile } = await import('../../worker/src/profile.js');
  const p = {
    ...draftProfile({ business_id: 'shiraz-salon-abc123', business_name: 'Shiraz Salon', business_type: 'hair salon' }),
    address: '5 Example Street', city: 'London',
    services: [{ id: 'cut', name_en: 'Cut', name_fa: 'کوتاهی', duration_min: 45, price: 35 }],
  };
  assert.deepEqual(validateProfile(p), []);
  const prompt = render(loadTemplate(), p);
  assert.doesNotMatch(prompt, /\{\{(?!system__)\w+\}\}|\bundefined\b|\bnull\b/);
  assert.match(prompt, /Shiraz Salon \(hair salon\)/);
});

test('scenarios cover the required cases and use known tools', () => {
  const cases = loadScenarios();
  const ids = cases.filter(c => !c.human_only).map(c => c.id);
  for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C15']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  const tools = new Set(loadTools().map(t => t.name));
  for (const c of cases) {
    for (const s of [...(c.expected_tools || []), ...(c.forbid_tools || [])]) assert.ok(tools.has(s.tool), `${c.id}: unknown tool ${s.tool}`);
    if (!c.human_only) assert.ok(c.caller_turns.length > 0, `${c.id} has no caller turns`);
  }
});
