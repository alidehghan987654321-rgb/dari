import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveBusiness, parseIdentifier, parseCookies, generateCode, generateToken, sessionCookie, canManage } from '../src/auth.js';
import { validateSettings, settingsOf, applySettings } from '../src/profile.js';
import { computeSlots } from '../src/lib.js';

const profile = JSON.parse(readFileSync(new URL('../../prompts/business_profile.example.json', import.meta.url)));

test('resolveBusiness: owners and staff are locked to their business', () => {
  const owner = { role: 'owner', business_id: 'a' };
  assert.deepEqual(resolveBusiness(owner, null), { ok: true, businessId: 'a' });
  assert.deepEqual(resolveBusiness(owner, 'a'), { ok: true, businessId: 'a' });
  assert.deepEqual(resolveBusiness(owner, 'b'), { ok: false, status: 403, error: 'forbidden' });
  assert.deepEqual(resolveBusiness({ role: 'staff', business_id: 'a' }, 'b').status, 403);
  assert.deepEqual(resolveBusiness({ role: 'superadmin', business_id: null }, 'b'), { ok: true, businessId: 'b' });
  assert.equal(resolveBusiness({ role: 'superadmin', business_id: null }, null).error, 'choose_business');
  assert.equal(canManage({ role: 'staff' }), false);
  assert.equal(canManage({ role: 'owner' }), true);
});

test('identifiers, cookies, codes, tokens', () => {
  assert.deepEqual(parseIdentifier(' Ali@Example.COM '), { kind: 'email', value: 'ali@example.com' });
  assert.deepEqual(parseIdentifier('۰۷۷۰۰ ۹۰۰۱۲۳'), { kind: 'phone', value: '+447700900123' });
  assert.equal(parseIdentifier('hello'), null);
  assert.equal(parseIdentifier('a@b'), null);
  assert.deepEqual(parseCookies('a=1; sid=abc-_x; b=2'), { a: '1', sid: 'abc-_x', b: '2' });
  for (let i = 0; i < 200; i++) assert.match(generateCode(), /^\d{6}$/);
  assert.match(generateToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(generateToken(), generateToken());
  assert.equal(sessionCookie('t', 0), 'sid=t; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
});

test('validateSettings accepts the example profile and rejects bad edits', () => {
  assert.deepEqual(validateSettings(settingsOf(profile)), []);
  const errs = s => validateSettings(s).map(e => `${e.field}:${e.error}`);
  assert.deepEqual(errs({ opening_hours: { mon: [['10:00', '09:00']] } }), ['opening_hours.mon:bad_range']);
  assert.deepEqual(errs({ opening_hours: { mon: [['10:00', '14:00'], ['13:00', '18:00']] } }), ['opening_hours.mon:overlap']);
  assert.deepEqual(errs({ opening_hours: { funday: [] } }), ['opening_hours.funday:unknown_day']);
  assert.deepEqual(errs({ closed_dates: ['2026-02-30'] }), ['closed_dates:invalid']);
  assert.deepEqual(errs({ capacity: 0 }), ['capacity:invalid']);
  assert.deepEqual(errs({ phone_for_transfer: '123' }), ['phone_for_transfer:invalid']);
  assert.deepEqual(errs({ services: [] }), ['services:invalid']);
  assert.deepEqual(errs({ services: [
    { id: 'cut', name_en: 'Cut', name_fa: 'اصلاح', duration_min: 30, price: 20 },
    { id: 'cut', name_en: '', name_fa: 'x', duration_min: 2, price: -1 },
  ] }), ['services.1.id:duplicate', 'services.1.name_en:required', 'services.1.duration_min:invalid', 'services.1.price:invalid']);
  assert.deepEqual(errs({ faq: [{ q: 'Q?', a: '' }] }), ['faq:invalid']);
});

test('applySettings only touches editable fields and normalises', () => {
  const next = applySettings(profile, { capacity: 3, business_name: 'Hacked', phone_for_transfer: '07700 900111', services: [{ id: 'x', name_en: ' X ', name_fa: 'ایکس', duration_min: 20, price: 12, extra: 1 }] });
  assert.equal(next.capacity, 3);
  assert.equal(next.business_name, profile.business_name);
  assert.equal(next.phone_for_transfer, '+447700900111');
  assert.deepEqual(next.services, [{ id: 'x', name_en: 'X', name_fa: 'ایکس', duration_min: 20, price: 12 }]);
  assert.equal(settingsOf(profile).services[0].price, 20, 'older price_gbp is shown as price');
});

test('panel can book from the next slot; the agent keeps the minimum notice', () => {
  const now = new Date('2026-10-06T12:07:00Z'); // Tue 13:07 UK
  const cut = profile.services[0];
  assert.equal(computeSlots({ profile, service: cut, date: '2026-10-06', now }).slots[0], '14:15');
  assert.equal(computeSlots({ profile, service: cut, date: '2026-10-06', now, minNoticeMinutes: 0 }).slots[0], '13:15');
});
