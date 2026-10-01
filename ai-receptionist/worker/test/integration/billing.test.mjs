// Integration (M6): Stripe setup, Checkout, Portal and the webhook lifecycle against a fake Stripe.
// Acceptance: trial -> paid -> payment failure -> recovery -> cancellation, all reflected in subscriptions and
// the panel; replayed webhooks ignored; invalid signatures rejected; overage invoiced once.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startDev, seedBusiness, nextWeekday, SECRETS } from './dev.mjs';
import { fakeStripe } from './fakes.mjs';

const BIZ = 'demo-barber-london';
const WHSEC = 'whsec_test';
let dev, stripe, sid, n = 0;

const day = d => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
const isoIn = days => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

function setSub(status, extra = {}) {
  stripe.subs.set('sub_1', {
    id: 'sub_1', object: 'subscription', status, customer: 'cus_1', cancel_at_period_end: false, trial_end: null,
    metadata: { business_id: BIZ, plan_id: 'basic' },
    items: { data: [{ current_period_start: day(isoIn(-1)), current_period_end: day(isoIn(29)), price: { id: 'price_basic' } }] },
    ...extra,
  });
}

async function send(type, object, id = `evt_${++n}`) {
  const payload = JSON.stringify({ id, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', WHSEC).update(`${t}.${payload}`).digest('hex');
  const r = await fetch(`${dev.url}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body: payload });
  return { status: r.status, data: await r.json() };
}
const panel = (method, path, body) => dev.call(method, path, { body, headers: { cookie: sid } });
const subscription = async () => (await panel('GET', '/api/account')).data;
const invoiceRef = { parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } } };

before(async () => {
  dev = await startDev({ varsFromMock: u => ({ STRIPE_API_BASE: u, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WHSEC }) });
  stripe = fakeStripe(dev.mock);
  await seedBusiness(dev, {}, 'agent_demo');
  await dev.admin('PUT', '/admin/users', { business_id: BIZ, name: 'Ali', phone: '07700900801', email: 'ali@example.com', role: 'owner' });
  await dev.admin('PUT', '/admin/subscriptions', { business_id: BIZ, plan_id: 'basic', status: 'trial', period_start: isoIn(-4), period_end: isoIn(26), trial_end: isoIn(10) });
  await dev.call('POST', '/api/auth/request-code', { body: { identifier: '07700900801' } });
  const sms = await dev.until(() => dev.mock.of('sms').at(-1));
  const v = await dev.call('POST', '/api/auth/verify', { body: { identifier: '07700900801', code: /(\d{6})/.exec(sms.body.Body)[1] } });
  sid = v.headers.get('set-cookie').split(';')[0];
});
after(() => dev?.stop());

test('setup creates one price per plan and is idempotent', async () => {
  const r = await dev.admin('POST', '/admin/stripe/setup');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.prices.map(p => p.plan_id).sort(), ['basic', 'pro']);
  const basic = stripe.prices.find(p => p.lookup_key === 'receptionist_basic');
  assert.deepEqual([basic.unit_amount, basic.currency], [7900, 'gbp']);
  await dev.admin('POST', '/admin/stripe/setup');
  assert.equal(stripe.prices.length, 2, 'found again by lookup_key, not recreated');
});

test('checkout: subscription mode, business reference, remaining trial carried over, VAT details collected', async () => {
  const account = await subscription();
  assert.equal(account.billing.enabled, true);
  assert.equal(account.billing.can_checkout, true);
  const r = await panel('POST', '/api/billing/checkout', { plan_id: 'basic' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.url, /^https:\/\/checkout\.stripe\.test\//);
  const s = stripe.checkouts.at(-1);
  assert.equal(s.mode, 'subscription');
  assert.equal(s['line_items[0][price]'], 'price_basic');
  assert.equal(s.client_reference_id, BIZ);
  assert.equal(s['subscription_data[metadata][business_id]'], BIZ);
  assert.equal(Number(s['subscription_data[trial_end]']), Math.floor(Date.parse(`${isoIn(10)}T23:59:59Z`) / 1000));
  assert.equal(s['tax_id_collection[enabled]'], 'true');
  assert.equal(s.billing_address_collection, 'required');
  assert.equal(s.customer_email, 'ali@example.com');
  assert.match(s.success_url, /\/panel\/#\/account\?checkout=success$/);
});

test('lifecycle: trial -> paid -> failure -> recovery -> cancellation', async () => {
  setSub('trialing', { trial_end: day(isoIn(10)) });
  let r = await send('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', client_reference_id: BIZ, customer: 'cus_1', subscription: 'sub_1' });
  assert.deepEqual([r.status, r.data.status], [200, 'trial']);
  let a = await subscription();
  assert.deepEqual([a.usage.status, a.billing.can_checkout, a.billing.has_portal], ['trial', false, true]);

  setSub('active');
  r = await send('customer.subscription.updated', stripe.subs.get('sub_1'));
  assert.equal(r.data.status, 'active');
  assert.equal((await subscription()).usage.status, 'active');

  dev.mock.clear();
  setSub('past_due');
  r = await send('invoice.payment_failed', { id: 'in_1', object: 'invoice', customer: 'cus_1', ...invoiceRef });
  assert.equal(r.data.status, 'past_due');
  assert.equal((await subscription()).usage.status, 'past_due');
  await dev.until(() => dev.mock.of('sms').some(m => m.body.To === '+447700900801' && /پرداخت/.test(m.body.Body)));
  assert.equal((await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: nextWeekday('thu') })).ok, true, 'grace period: still booking');

  setSub('active');
  r = await send('invoice.paid', { id: 'in_1', object: 'invoice', customer: 'cus_1', ...invoiceRef });
  assert.equal((await subscription()).usage.status, 'active');

  const portal = await panel('POST', '/api/billing/portal', {});
  assert.equal(portal.data.url, 'https://billing.stripe.test/cus_1');

  setSub('canceled');
  r = await send('customer.subscription.deleted', stripe.subs.get('sub_1'));
  assert.equal((await subscription()).usage.status, 'cancelled');
  assert.equal((await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: nextWeekday('thu') })).error, 'message_only');
  assert.equal((await subscription()).billing.can_checkout, true, 'can subscribe again');
});

test('replayed events are ignored; bad signatures rejected', async () => {
  setSub('past_due');
  dev.mock.clear();
  const evt = { id: 'in_9', object: 'invoice', customer: 'cus_1', ...invoiceRef };
  assert.equal((await send('invoice.payment_failed', evt, 'evt_replay')).data.duplicate, undefined);
  await dev.until(() => dev.mock.of('sms').some(m => /پرداخت/.test(m.body.Body)));
  const again = await send('invoice.payment_failed', evt, 'evt_replay');
  assert.equal(again.data.duplicate, true);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(dev.mock.of('sms').filter(m => /پرداخت/.test(m.body.Body)).length, 1, 'owner told once');

  const bad = await fetch(`${dev.url}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=00` }, body: '{"id":"evt_x","type":"invoice.paid","data":{"object":{}}}' });
  assert.equal(bad.status, 400);
  const none = await fetch(`${dev.url}/webhooks/stripe`, { method: 'POST', body: '{}' });
  assert.equal(none.status, 400);
});

test('renewal invoice gets the finished period overage, once', async () => {
  setSub('active');
  await send('customer.subscription.updated', stripe.subs.get('sub_1'));
  // 302 billed minutes in the period that just ended: 9061 s -> 152 (rounded up per call) + 9000 s -> 150.
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 2; i++) {
    const raw = JSON.stringify({ type: 'post_call_transcription', data: { agent_id: 'agent_demo', conversation_id: `ov_${i}`, metadata: { call_duration_secs: i ? 9000 : 9061 }, analysis: {}, transcript: [] } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v0=${createHmac('sha256', SECRETS.ELEVENLABS_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex')}`;
    assert.equal((await fetch(`${dev.url}/webhooks/post-call`, { method: 'POST', headers: { 'elevenlabs-signature': sig }, body: raw })).status, 200);
  }
  const invoice = { id: 'in_renew', object: 'invoice', status: 'draft', billing_reason: 'subscription_cycle', customer: 'cus_1', period_start: now - 3600, period_end: now + 60, ...invoiceRef };
  await send('invoice.created', invoice);
  await send('invoice.created', invoice);                // replay with the same event id is skipped above; a new id:
  await send('invoice.created', invoice, 'evt_other_id'); // ...is still charged only once
  assert.equal(stripe.invoiceItems.length, 1);
  const item = stripe.invoiceItems[0];
  assert.deepEqual([item.invoice, item.customer, Number(item.amount), item.currency], ['in_renew', 'cus_1', (302 - 300) * 25, 'gbp']);
  assert.match(item.description, /Extra minutes: 2/);

  await send('invoice.created', { ...invoice, id: 'in_first', billing_reason: 'subscription_create' });
  assert.equal(stripe.invoiceItems.length, 1, 'only renewals carry overage');
});

test('staff cannot open billing', async () => {
  await dev.admin('PUT', '/admin/users', { business_id: BIZ, name: 'Sara', phone: '07700900802', role: 'staff' });
  await dev.call('POST', '/api/auth/request-code', { body: { identifier: '07700900802' } });
  const sms = await dev.until(() => dev.mock.of('sms').find(m => m.body.To === '+447700900802'));
  const v = await dev.call('POST', '/api/auth/verify', { body: { identifier: '07700900802', code: /(\d{6})/.exec(sms.body.Body)[1] } });
  const staff = v.headers.get('set-cookie').split(';')[0];
  const r = await dev.call('POST', '/api/billing/checkout', { body: { plan_id: 'basic' }, headers: { cookie: staff } });
  assert.equal(r.status, 403);
});
