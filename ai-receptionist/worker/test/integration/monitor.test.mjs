// Integration (M2): tool events, alerts to the team chat, dry-run bookings, synthetic check, /admin/health.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDev, seedBusiness, nextWeekday } from './dev.mjs';

const ALERTS = '*/5 * * * *';
const DAILY = '17 3 * * *';
const TEAM = { TEAM_ALERT_CHAT_ID: 'team-chat' };
const teamMessages = dev => dev.mock.of('telegram').filter(m => m.body.chat_id === 'team-chat').map(m => m.body.text);

describe('D1 binding killed', () => {
  let dev;
  before(async () => { dev = await startDev({ noDatabase: true, vars: TEAM }); });
  after(() => dev?.stop());

  test('tool calls fail safely and one cron run raises the alerts, once', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await dev.tool('demo-barber-london', 'availability', { service_id: 'mens-cut', date: nextWeekday('thu') });
      assert.deepEqual([r.ok, r.error], [false, 'server_error']);
      assert.match(r.message_for_agent, /take a message/);
    }
    await dev.cron(ALERTS);
    const sent = teamMessages(dev);
    assert.ok(sent.some(t => /Database \(D1\) is not answering/.test(t)), sent.join('\n'));
    assert.ok(sent.some(t => /demo-barber-london: availability failing — 6\/6/.test(t)), sent.join('\n'));

    await dev.cron(ALERTS);
    assert.equal(teamMessages(dev).length, sent.length, 'not repeated within the hour');
  });
});

describe('healthy database', () => {
  let dev;
  const BIZ = 'demo-barber-london';
  before(async () => {
    dev = await startDev({ vars: TEAM });
    await seedBusiness(dev);
    await seedBusiness(dev, { business_id: 'never-open', opening_hours: {} });
  });
  after(() => dev?.stop());

  test('dry_run validates without writing or notifying', async () => {
    dev.mock.clear();
    const thu = nextWeekday('thu');
    const r = await dev.tool(BIZ, 'book', { service_id: 'mens-cut', date: thu, time: '11:00', customer_name: 'Dry', customer_phone: '07700900100', language: 'en', dry_run: true });
    assert.deepEqual([r.ok, r.dry_run, r.time], [true, true, '11:00']);
    const bad = await dev.tool(BIZ, 'book', { service_id: 'mens-cut', date: nextWeekday('sun'), time: '11:00', customer_name: 'Dry', customer_phone: '07700900100', dry_run: true });
    assert.equal(bad.error, 'closed');
    const list = await dev.admin('GET', `/admin/b/${BIZ}/bookings?date=${thu}`);
    assert.equal(list.data.bookings.length, 0);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(dev.mock.requests.length, 0);
  });

  test('failed SMS sends raise one alert; health shows the numbers', async () => {
    dev.mock.fail.add('sms');
    const thu = nextWeekday('thu');
    for (const [i, time] of ['12:00', '12:30', '13:00'].entries()) {
      const r = await dev.tool(BIZ, 'book', { service_id: 'mens-cut', date: thu, time, customer_name: 'Sam', customer_phone: `0770090011${i}`, language: 'en' });
      assert.equal(r.ok, true, 'a failed SMS never breaks the booking');
    }
    await dev.until(() => dev.mock.of('sms').length >= 3);
    await new Promise(r => setTimeout(r, 300)); // let waitUntil record the events
    await dev.cron(ALERTS);
    const alerts = teamMessages(dev).filter(t => /sends failed/.test(t));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /demo-barber-london: 3 sms sends failed/);
    await dev.cron(ALERTS);
    assert.equal(teamMessages(dev).filter(t => /sends failed/.test(t)).length, 1);

    const health = await dev.admin('GET', '/admin/health');
    const h = health.data.businesses.find(b => b.business_id === BIZ);
    assert.equal(h.sms_failures_24h, 3);
    assert.ok(h.tool_calls_24h >= 4);
    assert.equal(h.tool_error_rate, 0);
    assert.equal(typeof h.p95_ms, 'number');
    dev.mock.fail.delete('sms');
  });

  test('daily synthetic check passes for a healthy business and alerts for a broken one', async () => {
    await dev.cron(DAILY);
    const health = (await dev.admin('GET', '/admin/health')).data.businesses;
    assert.deepEqual(health.find(b => b.business_id === BIZ).synthetic.ok, true);
    assert.deepEqual(health.find(b => b.business_id === 'never-open').synthetic, { ok: false, error: 'no_open_days', ts: health.find(b => b.business_id === 'never-open').synthetic.ts });
    const before = (await dev.admin('GET', `/admin/b/${BIZ}/bookings`)).data.bookings.length;
    await dev.cron(ALERTS);
    assert.ok(teamMessages(dev).some(t => /never-open: daily self-test failed \(no_open_days\)/.test(t)));
    assert.equal((await dev.admin('GET', `/admin/b/${BIZ}/bookings`)).data.bookings.length, before, 'synthetic check never books');
  });

  test('tool logs are one JSON line without personal data', async () => {
    await dev.tool(BIZ, 'find-bookings', { customer_phone: '07700900555' });
    await new Promise(r => setTimeout(r, 300));
    const lines = dev.log().split('\n').filter(l => l.includes('"evt":"tool"'));
    assert.ok(lines.length > 0, 'tool events are logged');
    const last = JSON.parse(lines.at(-1).slice(lines.at(-1).indexOf('{')));
    assert.deepEqual(Object.keys(last).sort(), ['business_id', 'error', 'evt', 'ms', 'ok', 'tool', 'ts']);
    for (const l of lines) assert.doesNotMatch(l, /7700900|Sam/);
  });
});
