import test from 'node:test';
import assert from 'node:assert/strict';
import {
  londonNow, computeSlots, sortByPreferred, normalizePhone, isUkMobile, parseHHMM,
  verifyElevenLabsSignature, formatDate, bookingSms, weekdayOf, bookingId, smsSegments,
} from '../src/lib.js';
import { readFileSync } from 'node:fs';

const profile = JSON.parse(readFileSync(new URL('../../prompts/business_profile.example.json', import.meta.url)));
const cut = profile.services.find(s => s.id === 'mens-cut');

test('londonNow handles BST and GMT', () => {
  assert.equal(londonNow(new Date('2026-07-01T12:00:00Z')).minutes, 13 * 60);   // BST = UTC+1
  assert.equal(londonNow(new Date('2026-12-01T12:00:00Z')).minutes, 12 * 60);   // GMT
  assert.equal(londonNow(new Date('2026-07-01T23:30:00Z')).date, '2026-07-02'); // after midnight UK
});

test('weekday', () => {
  assert.equal(weekdayOf('2026-10-06'), 'tue');
  assert.equal(weekdayOf('2026-10-11'), 'sun');
});

test('closed on Sunday and closed dates', () => {
  const now = new Date('2026-10-05T09:00:00Z');
  assert.equal(computeSlots({ profile, service: cut, date: '2026-10-11', now }).reason, 'closed');
  assert.equal(computeSlots({ profile, service: cut, date: '2026-12-25', now: new Date('2026-12-01T09:00:00Z') }).reason, 'closed');
});

test('past and too far', () => {
  const now = new Date('2026-10-05T09:00:00Z');
  assert.equal(computeSlots({ profile, service: cut, date: '2026-10-04', now }).reason, 'past_date');
  assert.equal(computeSlots({ profile, service: cut, date: '2026-12-30', now }).reason, 'too_far');
  assert.equal(computeSlots({ profile, service: cut, date: '2026-02-30', now }).reason, 'bad_date');
});

test('slots fit inside opening hours', () => {
  const now = new Date('2026-10-05T06:00:00Z');
  const r = computeSlots({ profile, service: cut, date: '2026-10-06', now }); // Tue 10:00-19:00
  assert.equal(r.slots[0], '10:00');
  assert.equal(r.slots.at(-1), '18:30');
  assert.equal(r.slots.length, (19 * 60 - 30 - 10 * 60) / 15 + 1);
});

test('capacity 2: slot blocked only when 2 overlapping bookings', () => {
  const now = new Date('2026-10-05T06:00:00Z');
  const one = [{ id: 'A', start_min: 600, end_min: 630 }];
  const two = [...one, { id: 'B', start_min: 600, end_min: 645 }];
  assert.ok(computeSlots({ profile, service: cut, date: '2026-10-06', bookings: one, now }).slots.includes('10:00'));
  const r = computeSlots({ profile, service: cut, date: '2026-10-06', bookings: two, now });
  assert.ok(!r.slots.includes('10:00'));
  assert.ok(!r.slots.includes('10:15'));
  assert.ok(r.slots.includes('10:45'));
  // excludeId frees the booking being rescheduled
  assert.ok(computeSlots({ profile, service: cut, date: '2026-10-06', bookings: two, now, excludeId: 'B' }).slots.includes('10:00'));
});

test('same-day minimum notice', () => {
  const now = new Date('2026-10-06T11:05:00Z'); // 12:05 UK (BST)
  const r = computeSlots({ profile, service: cut, date: '2026-10-06', now });
  assert.equal(r.slots[0], '13:15'); // 12:05 + 60 min notice -> first 15-min step at/after 13:05
});

test('preferred time sorting', () => {
  assert.deepEqual(sortByPreferred(['10:00', '11:00', '12:00', '15:00'], '11:40').slice(0, 2), ['12:00', '11:00']);
  assert.deepEqual(sortByPreferred(['10:00'], 'nonsense'), ['10:00']);
});

test('phone normalisation incl. Persian digits', () => {
  assert.equal(normalizePhone('07700 900123'), '+447700900123');
  assert.equal(normalizePhone('+44 (0)7700-900123'), '+447700900123');
  assert.equal(normalizePhone('00447700900123'), '+447700900123');
  assert.equal(normalizePhone('۰۷۷۰۰۹۰۰۱۲۳'), '+447700900123');
  assert.equal(normalizePhone('12345'), null);
  assert.ok(isUkMobile('+447700900123'));
  assert.ok(!isUkMobile('+442071234567'));
});

test('parse time with Persian digits', () => {
  assert.equal(parseHHMM('۱۵:۳۰'), 930);
  assert.equal(parseHHMM('24:00'), null);
});

test('formatting and SMS', () => {
  assert.equal(formatDate('2026-10-06', 'en'), 'Tue 6 Oct');
  assert.equal(formatDate('2026-10-06', 'fa'), 'سه‌شنبه ۶ اکتبر');
  const sms = bookingSms({ lang: 'fa', businessName: 'Pars Barbers', serviceName: 'اصلاح', date: '2026-10-06', time: '15:30', id: 'K7QX2M', address: 'x' });
  assert.match(sms, /۱۵:۳۰/);
});

test('confirmation SMS stays within segment budget', () => {
  const base = { businessName: 'Pars Barbers', serviceName: 'x', date: '2026-10-06', time: '15:30', id: 'K7QX2M', address: 'x' };
  assert.ok(smsSegments(bookingSms({ ...base, lang: 'fa' })) <= 2);
  assert.equal(smsSegments(bookingSms({ ...base, lang: 'en' })), 1);
  assert.equal(smsSegments('a'.repeat(161)), 2);
  assert.equal(smsSegments('س'.repeat(71)), 2);
});

test('booking ids are readable', () => {
  const id = bookingId();
  assert.match(id, /^[A-HJ-NP-Z2-9]{6}$/);
});

test('ElevenLabs signature', async () => {
  const secret = 'whsec_test', body = '{"type":"post_call_transcription"}', t = 1790000000;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))).toString('hex');
  assert.ok(await verifyElevenLabsSignature(secret, `t=${t},v0=${sig}`, body, t + 10));
  assert.ok(!(await verifyElevenLabsSignature(secret, `t=${t},v0=${sig}`, body + 'x', t + 10)));
  assert.ok(!(await verifyElevenLabsSignature(secret, `t=${t},v0=${sig}`, body, t + 99999)));
});
