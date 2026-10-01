// Integration: the six agent tools and the post-call webhook against `wrangler dev` + local D1.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startDev, seedBusiness, nextWeekday, SECRETS } from './dev.mjs';

let dev;
const BIZ = 'demo-barber-london';
const thu = nextWeekday('thu');
const sun = nextWeekday('sun');

before(async () => {
  dev = await startDev();
  await seedBusiness(dev, {}, 'agent_demo');
});
after(() => dev?.stop());

export function signedWebhook(event, secret = SECRETS.ELEVENLABS_WEBHOOK_SECRET) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v0 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { body, signature: `t=${t},v0=${v0}` };
}

test('tool routes require the tool secret', async () => {
  const r = await dev.call('POST', `/b/${BIZ}/availability`, { body: {} });
  assert.equal(r.status, 401);
});

test('availability: open day, closed day, unknown service', async () => {
  const open = await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: thu, preferred_time: '17:00' });
  assert.equal(open.ok, true);
  assert.equal(open.slots[0], '17:00');
  const closed = await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: sun });
  assert.deepEqual([closed.ok, closed.error], [false, 'closed']);
  const bad = await dev.tool(BIZ, 'availability', { service_id: 'perm', date: thu });
  assert.equal(bad.error, 'unknown_service');
});

test('book respects capacity, then find, reschedule and cancel', async () => {
  const base = { service_id: 'mens-cut', date: thu, time: '12:00', customer_name: 'Reza', language: 'fa' };
  const a = await dev.tool(BIZ, 'book', { ...base, customer_phone: '07700 900111' });
  const b = await dev.tool(BIZ, 'book', { ...base, customer_phone: '۰۷۷۰۰۹۰۰۱۱۲' });
  const c = await dev.tool(BIZ, 'book', { ...base, customer_phone: '07700900113' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual([c.ok, c.error], [false, 'slot_taken']); // capacity 2

  // SMS confirmation in Persian went to the mock Twilio, Telegram to the owner.
  await dev.until(() => dev.mock.of('sms').length >= 2);
  assert.match(dev.mock.of('sms')[0].body.Body, /ثبت شد/);

  const found = await dev.tool(BIZ, 'find-bookings', { customer_phone: '+447700900111' });
  assert.equal(found.bookings[0].booking_id, a.booking_id);

  const moved = await dev.tool(BIZ, 'reschedule', { booking_id: a.booking_id, customer_phone: '07700900111', new_date: thu, new_time: '13:00' });
  assert.equal(moved.ok, true);
  const cancelled = await dev.tool(BIZ, 'cancel', { booking_id: b.booking_id, customer_phone: '07700900112' });
  assert.equal(cancelled.cancelled, true);
  const again = await dev.tool(BIZ, 'book', { ...base, customer_phone: '07700900113' });
  assert.equal(again.ok, true, 'both 12:00 places freed');
});

test('simultaneous bookings never exceed capacity', async () => {
  const base = { service_id: 'mens-cut', date: thu, time: '15:00', customer_name: 'Race', language: 'en' };
  const results = await Promise.all([1, 2, 3, 4, 5].map(i => dev.tool(BIZ, 'book', { ...base, customer_phone: `0770090020${i}` })));
  assert.equal(results.filter(r => r.ok).length, 2);
});

test('message is stored and the owner is told', async () => {
  dev.mock.clear();
  const r = await dev.tool(BIZ, 'message', { caller_name: 'Ali', caller_phone: '07700900300', message: 'Call me back', urgency: 'urgent' });
  assert.equal(r.ok, true);
  await dev.until(() => dev.mock.of('telegram').some(m => /URGENT/.test(m.body.text)));
});

test('post-call webhook: signature checked, call stored', async () => {
  const event = {
    type: 'post_call_transcription',
    data: {
      agent_id: 'agent_demo', conversation_id: 'conv_1',
      metadata: { call_duration_secs: 95, phone_call: { external_number: '+447700900400' } },
      analysis: { transcript_summary: 'Booked a haircut.', call_successful: 'success', data_collection_results: {} },
      transcript: [{ role: 'agent', message: 'Hello' }],
    },
  };
  const bad = await dev.call('POST', '/webhooks/post-call', { body: event, headers: { 'elevenlabs-signature': 't=1,v0=00' } });
  assert.equal(bad.status, 401);
  const { body, signature } = signedWebhook(event);
  const r = await fetch(`${dev.url}/webhooks/post-call`, { method: 'POST', headers: { 'elevenlabs-signature': signature }, body });
  assert.equal(r.status, 200);
  const calls = await dev.admin('GET', `/admin/b/${BIZ}/calls`);
  assert.equal(calls.data.calls[0].conversation_id, 'conv_1');
});
