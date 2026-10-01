// Integration (M4): usage from post-call webhooks, threshold notices, message-only mode, margin report.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startDev, seedBusiness, nextWeekday, SECRETS } from './dev.mjs';

let dev;
const BIZ = 'demo-barber-london';
const HOURLY = '7 * * * *';
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const periodEnd = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);

function webhook(conversationId, secs) {
  const raw = JSON.stringify({
    type: 'post_call_transcription',
    data: { agent_id: 'agent_demo', conversation_id: conversationId, metadata: { call_duration_secs: secs }, analysis: { transcript_summary: 'x', call_successful: 'success' }, transcript: [] },
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v0=${createHmac('sha256', SECRETS.ELEVENLABS_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex')}`;
  return fetch(`${dev.url}/webhooks/post-call`, { method: 'POST', headers: { 'elevenlabs-signature': sig }, body: raw });
}
const ownerTexts = () => dev.mock.requests.filter(m =>
  (m.service === 'telegram' && m.body.chat_id === '123456789') || (m.service === 'sms' && m.body.To === '+447700900801'));
const subscribe = (status, extra = {}) => dev.admin('PUT', '/admin/subscriptions', { business_id: BIZ, plan_id: 'basic', status, period_start: `${month}-01`, period_end: periodEnd, ...extra });
const usage = async () => (await dev.call('GET', '/api/today', { headers: { cookie: sid } })).data.usage;
let sid;

before(async () => {
  dev = await startDev();
  await seedBusiness(dev, {}, 'agent_demo');
  await dev.admin('PUT', '/admin/users', { business_id: BIZ, name: 'Ali', phone: '07700900801', role: 'owner' });
  assert.equal((await subscribe('active')).status, 200);
  await dev.call('POST', '/api/auth/request-code', { body: { identifier: '07700900801' } });
  const sms = await dev.until(() => dev.mock.of('sms').at(-1));
  const v = await dev.call('POST', '/api/auth/verify', { body: { identifier: '07700900801', code: /(\d{6})/.exec(sms.body.Body)[1] } });
  sid = v.headers.get('set-cookie').split(';')[0];
  dev.mock.clear();
});
after(() => dev?.stop());

// 50 calls; durations chosen so per-call rounding matters (61 s bills 2 minutes, 60 s bills 1).
const DURATIONS = Array.from({ length: 50 }, (_, i) => [181, 60, 419, 480, 599][i % 5] + (i % 7 === 0 ? 1 : 0));
const EXPECTED = DURATIONS.reduce((n, s) => n + Math.ceil(s / 60), 0);

test('50 replayed post-call webhooks: per-call rounding, replays ignored, notices once', async () => {
  assert.ok(EXPECTED > 300, `the run crosses the 300-minute plan (${EXPECTED})`);
  for (let i = 0; i < 50; i += 10) {
    const batch = DURATIONS.slice(i, i + 10).map((s, j) => webhook(`conv_${i + j}`, s));
    for (const r of await Promise.all(batch)) assert.equal(r.status, 200);
  }
  for (let i = 0; i < 5; i++) assert.equal((await webhook(`conv_${i}`, DURATIONS[i])).status, 200); // replays

  const u = await usage();
  assert.equal(u.calls, 50);
  assert.equal(u.minutes_used, EXPECTED);
  assert.equal(u.included_minutes, 300);
  assert.equal(u.plan.id, 'basic');

  await dev.until(() => ownerTexts().filter(m => /\b100\b|۱۰۰|used up|تمام شد/.test(m.body.text || m.body.Body)).length >= 2);
  await dev.cron(HOURLY);
  await dev.cron(HOURLY);
  await new Promise(r => setTimeout(r, 300));
  const texts = ownerTexts().map(m => m.body.text || m.body.Body);
  assert.equal(texts.filter(t => /\(۸۰٪\)|\(80%\)/.test(t)).length, 2, '80%: one Telegram + one SMS');
  assert.equal(texts.filter(t => /تمام شد|used up/.test(t)).length, 2, '100%: one Telegram + one SMS');
  assert.equal(u.message_only, false, 'without a hard cap the receptionist keeps answering');
});

test('hard cap -> message-only: bookings refused, messages still taken', async () => {
  const settings = (await dev.call('GET', '/api/settings', { headers: { cookie: sid } })).data.settings;
  assert.equal(settings.hard_cap, false);
  const save = await dev.call('PUT', '/api/settings', { body: { hard_cap: true }, headers: { cookie: sid } });
  assert.equal(save.status, 200);
  await dev.cron(HOURLY);

  const thu = nextWeekday('thu');
  const avail = await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: thu });
  assert.equal(avail.error, 'message_only');
  assert.match(avail.message_for_agent, /take_message/);
  const msg = await dev.tool(BIZ, 'message', { caller_name: 'X', caller_phone: '07700900815', message: 'hi', urgency: 'normal' });
  assert.equal(msg.ok, true);
  const me = (await dev.call('GET', '/api/me', { headers: { cookie: sid } })).data.business;
  assert.deepEqual([me.message_only, me.message_only_reason], [true, 'hard_cap']);

  // Saving settings while in message-only mode never writes the system flag into the profile.
  await dev.call('PUT', '/api/settings', { body: { hard_cap: false }, headers: { cookie: sid } });
  await dev.cron(HOURLY);
  assert.equal((await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: thu })).ok, true, 'back to normal');
});

test('past_due: message-only only after the 3-day grace; payment brings it back', async () => {
  const thu = nextWeekday('thu');
  await subscribe('past_due');
  await dev.cron(HOURLY);
  assert.equal((await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: thu })).ok, true, 'inside the grace period');

  await subscribe('past_due', { status_changed_at: new Date(Date.now() - 4 * 864e5).toISOString() });
  await dev.cron(HOURLY);
  assert.equal((await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: thu })).error, 'message_only');

  await subscribe('active');
  await dev.cron(HOURLY);
  assert.equal((await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: thu })).ok, true);
});

test('SMS segments are counted; margin report adds up', async () => {
  const thu = nextWeekday('thu');
  const b = await dev.tool(BIZ, 'book', { service_id: 'mens-cut', date: thu, time: '12:00', customer_name: 'Reza', customer_phone: '07700900816', language: 'fa' });
  assert.equal(b.ok, true);
  await dev.until(async () => (await usage()).sms_segments >= 2 + 2 + 2); // two usage notices + this confirmation, Persian: 2 segments each

  const r = await dev.admin('GET', `/admin/usage?period=${month}`);
  assert.equal(r.status, 200);
  const row = r.data.businesses.find(x => x.business_id === BIZ);
  assert.equal(row.minutes, EXPECTED);
  assert.equal(row.overage_minutes, EXPECTED - 300);
  assert.equal(row.revenue, 7900 + (EXPECTED - 300) * 25);
  const exactMinutes = DURATIONS.reduce((n, s) => n + s, 0) / 60;
  assert.ok(Math.abs(row.cost_breakdown.voice - exactMinutes * 9) < 0.05, 'voice cost from exact seconds at the configured rate');
  assert.equal(row.cost_breakdown.sms, row.sms_segments * 4);
  assert.equal((await dev.admin('GET', '/admin/usage?period=2026-13')).status, 400);
});
