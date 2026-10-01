import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateAlerts, planAlerts, percentile, maskPhone, openMinutesInWindow, isFailure } from '../src/monitor.js';

const profile = JSON.parse(readFileSync(new URL('../../prompts/business_profile.example.json', import.meta.url)));
const ev = (tool, ok, error = null, ms = 100, business_id = 'b1') => ({ business_id, tool, ok, error, ms });

test('helpers', () => {
  assert.equal(maskPhone('+447700900123'), '*********123');
  assert.equal(maskPhone('12'), '***');
  assert.equal(percentile([5, 1, 4, 2, 3], 95), 5);
  assert.equal(percentile([], 95), null);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
  assert.equal(isFailure(ev('book', false, 'slot_taken')), false, 'business outcomes are not failures');
  assert.equal(isFailure(ev('book', false, 'server_error')), true);
  assert.equal(isFailure(ev('sms', false, 'send_failed')), true);
});

test('error rate: > 20% with at least 5 calls, per business and tool', () => {
  const four = [ev('book', false, 'server_error'), ev('book', false, 'server_error'), ev('book', true), ev('book', true)];
  assert.deepEqual(evaluateAlerts({ events: four }), [], 'needs 5 calls');
  const five = [...four, ev('book', true)];
  const alerts = evaluateAlerts({ events: five });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, 'error_rate:b1:book');
  assert.match(alerts[0].text, /2\/5/);
  const oneIn5 = [ev('book', false, 'server_error'), ev('book', true), ev('book', true), ev('book', true), ev('book', true)];
  assert.deepEqual(evaluateAlerts({ events: oneIn5 }), [], 'exactly 20% is not above 20%');
  const taken = Array.from({ length: 6 }, () => ev('book', false, 'slot_taken'));
  assert.deepEqual(evaluateAlerts({ events: taken }), [], 'slot_taken is a normal answer');
});

test('latency: p95 over 2500 ms', () => {
  const slow = Array.from({ length: 10 }, (_, i) => ev('availability', true, null, i < 8 ? 200 : 4000));
  assert.equal(evaluateAlerts({ events: slow })[0].key, 'latency:b1');
  const fine = Array.from({ length: 10 }, () => ev('availability', true, null, 900));
  assert.deepEqual(evaluateAlerts({ events: fine }), []);
});

test('notification failures: 3 or more in the window', () => {
  const events = [ev('sms', false, 'send_failed'), ev('telegram', false, 'send_failed'), ev('sms', true)];
  assert.deepEqual(evaluateAlerts({ events }), []);
  events.push(ev('sms', false, 'send_failed'));
  const [a] = evaluateAlerts({ events });
  assert.equal(a.key, 'notify:b1');
  assert.match(a.text, /3 sms \+ telegram/);
});

test('silent business, synthetic failure, database down', () => {
  const callStats = [
    { business_id: 'busy', avg_per_day: 8, calls_24h: 0, open_minutes_24h: 540 },
    { business_id: 'quiet', avg_per_day: 2, calls_24h: 0, open_minutes_24h: 540 },
    { business_id: 'sunday', avg_per_day: 8, calls_24h: 0, open_minutes_24h: 60 },
    { business_id: 'ok', avg_per_day: 8, calls_24h: 3, open_minutes_24h: 540 },
  ];
  const keys = evaluateAlerts({ callStats, synthetic: [{ business_id: 'x', ok: false, error: 'no_open_days' }], dbDown: true }).map(a => a.key);
  assert.deepEqual(keys.sort(), ['database', 'silent:busy', 'synthetic:x']);
});

test('opening minutes in the last 24 h follow the profile and timezone', () => {
  // Tue 2026-10-06 12:00 UK (BST) -> window Mon 12:00..Tue 12:00: Mon 12-19 (420) + Tue 10-12 (120)
  assert.equal(openMinutesInWindow(profile, new Date('2026-10-06T11:00:00Z')), 540);
  // Mon 2026-10-05 09:00 UK -> Sun 09:00..Mon 09:00: Sunday closed, Monday opens at 10
  assert.equal(openMinutesInWindow(profile, new Date('2026-10-05T08:00:00Z')), 0);
  // Closed date counts as closed: 26 Dec 2026 (Sat) is in closed_dates
  assert.equal(openMinutesInWindow(profile, new Date('2026-12-26T20:00:00Z')), 0);
});

test('dedupe: fire once, repeat hourly, resolve when gone', () => {
  const a = { key: 'error_rate:b1:book', rule: 'error_rate', business_id: 'b1', text: 'b1: book failing' };
  const t0 = new Date('2026-10-01T10:00:00Z');
  const first = planAlerts([a], [], t0);
  assert.equal(first.send.length, 1);
  assert.match(first.send[0].text, /^🔴/);
  const state = first.upsert;

  const t1 = new Date('2026-10-01T10:05:00Z');
  assert.equal(planAlerts([a], state, t1).send.length, 0, 'not again within the hour');

  const t2 = new Date('2026-10-01T11:00:00Z');
  const repeat = planAlerts([a], state, t2);
  assert.equal(repeat.send.length, 1);
  assert.match(repeat.send[0].text, /Still failing/);

  const resolved = planAlerts([], repeat.upsert, new Date('2026-10-01T11:05:00Z'));
  assert.match(resolved.send[0].text, /^✅ Resolved/);
  assert.equal(resolved.upsert[0].active, 0);
  assert.equal(planAlerts([], resolved.upsert, new Date('2026-10-01T11:10:00Z')).send.length, 0, 'resolved only once');
  assert.equal(planAlerts([a], resolved.upsert, new Date('2026-10-01T11:15:00Z')).send.length, 1, 'fires again if it comes back');
});
