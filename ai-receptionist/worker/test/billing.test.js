import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { encodeForm, verifyStripeSignature, mapStatus, subscriptionRow, overageCharge } from '../src/billing.js';
import { usageRules } from '../src/usage.js';

test('Stripe form encoding of nested params', () => {
  const s = encodeForm({
    mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], subscription_data: { trial_end: 1700000000, metadata: { business_id: 'b' } },
    tax_id_collection: { enabled: true }, lookup_keys: ['a', 'b'], skip: undefined, none: null,
  }).toString();
  assert.equal(decodeURIComponent(s),
    'mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&subscription_data[trial_end]=1700000000&subscription_data[metadata][business_id]=b&tax_id_collection[enabled]=true&lookup_keys[0]=a&lookup_keys[1]=b');
});

test('webhook signature: valid, wrong secret, stale, multiple v1', async () => {
  const payload = '{"id":"evt_1"}';
  const t = 1_800_000_000;
  const sig = createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
  assert.equal(await verifyStripeSignature('whsec_test', `t=${t},v1=${sig}`, payload, t + 10), true);
  assert.equal(await verifyStripeSignature('whsec_test', `t=${t},v1=deadbeef,v1=${sig}`, payload, t), true, 'any v1 may match (secret rotation)');
  assert.equal(await verifyStripeSignature('whsec_other', `t=${t},v1=${sig}`, payload, t), false);
  assert.equal(await verifyStripeSignature('whsec_test', `t=${t},v1=${sig}`, payload, t + 301), false, 'older than 5 minutes');
  assert.equal(await verifyStripeSignature('whsec_test', `t=${t},v1=${sig}`, payload + ' ', t), false, 'body changed');
  assert.equal(await verifyStripeSignature('whsec_test', null, payload, t), false);
});

test('status mapping and subscription row (period from items, API 2026-08-26)', () => {
  assert.deepEqual(['trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled', 'incomplete_expired'].map(mapStatus),
    ['trial', 'active', 'past_due', 'past_due', 'paused', 'cancelled', 'cancelled']);
  const row = subscriptionRow({
    id: 'sub_1', status: 'active', customer: 'cus_1', cancel_at_period_end: true, trial_end: null,
    items: { data: [{ current_period_start: Date.UTC(2026, 9, 5) / 1000, current_period_end: Date.UTC(2026, 10, 5) / 1000, price: { id: 'price_basic' } }] },
  }, 'basic');
  assert.deepEqual(row, {
    plan_id: 'basic', status: 'active', period_start: '2026-10-05', period_end: '2026-11-05', trial_end: null,
    stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', cancel_at_period_end: 1,
  });
});

test('overage charge', () => {
  const basic = { included_minutes: 300, overage_per_min: 25 };
  assert.deepEqual(overageCharge(basic, 299), { minutes: 0, amount: 0 });
  assert.deepEqual(overageCharge(basic, 302), { minutes: 2, amount: 50 });
});

test('a trial that ended unpaid goes message-only after the grace period', () => {
  const plan = { included_minutes: 300 };
  const sub = { status: 'trial', trial_end: '2026-10-10', status_changed_at: '2026-09-26T00:00:00Z' };
  assert.equal(usageRules({ plan, sub, usedMinutes: 0, now: new Date('2026-10-12T12:00:00Z') }).messageOnly, false);
  assert.deepEqual(usageRules({ plan, sub, usedMinutes: 0, now: new Date('2026-10-14T00:00:00Z') }).reason, 'trial_ended');
});
