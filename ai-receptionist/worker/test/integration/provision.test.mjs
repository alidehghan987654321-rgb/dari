// Integration (M5): agent provisioning against a stateful fake of the ElevenLabs and Twilio APIs.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDev, seedBusiness, nextWeekday } from './dev.mjs';
import { fakePlatform } from './fakes.mjs';

const BIZ = 'demo-barber-london';
const PROVISIONING = mockUrl => ({ ELEVENLABS_API_BASE: mockUrl, WORKER_PUBLIC_URL: 'https://receptionist.example', ELEVENLABS_POST_CALL_WEBHOOK_ID: 'wh_post', ELEVENLABS_VOICES: '{"en":"v_en","fa":"v_fa"}', TEAM_ALERT_CHAT_ID: 'team-chat' });

describe('provisioning with a Twilio bundle', () => {
  let dev, st, sid;
  const provision = body => dev.admin('POST', `/admin/b/${BIZ}/provision`, body);

  before(async () => {
    dev = await startDev({ vars: { TWILIO_BUNDLE_SID: 'BU1', TWILIO_ADDRESS_SID: 'AD1' }, varsFromMock: PROVISIONING });
    st = fakePlatform(dev.mock);
    await seedBusiness(dev);
    await dev.admin('PUT', '/admin/users', { business_id: BIZ, name: 'Ali', phone: '07700900801', role: 'owner' });
    await dev.call('POST', '/api/auth/request-code', { body: { identifier: '07700900801' } });
    const sms = await dev.until(() => dev.mock.of('sms').at(-1));
    const v = await dev.call('POST', '/api/auth/verify', { body: { identifier: '07700900801', code: /(\d{6})/.exec(sms.body.Body)[1] } });
    sid = v.headers.get('set-cookie').split(';')[0];
  });
  after(() => dev?.stop());

  test('create builds 6 tools and an agent; running it twice does not duplicate', async () => {
    const first = await provision({ action: 'create' });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.created, true);
    assert.equal(st.agents.size, 1);
    assert.equal(st.tools.size, 6);
    assert.equal(st.secrets, 1);
    const agent = st.agents.get(first.data.agent_id);
    assert.match(agent.conversation_config.agent.prompt.prompt, /You are Sara, the phone receptionist for Pars Barbers/);
    assert.match(agent.conversation_config.agent.first_message, /Pars Barbers/);
    assert.deepEqual(agent.conversation_config.agent.prompt.tool_ids.sort(), [...st.tools.keys()].sort());
    const tool = [...st.tools.values()].find(t => t.tool_config.name === 'check_availability').tool_config;
    assert.equal(tool.api_schema.url, `https://receptionist.example/b/${BIZ}/availability`);

    // Re-running the CLI re-uploads the profile without an agent_id first: that must not forget the agent.
    await seedBusiness(dev);
    const second = await provision({ action: 'create' });
    assert.equal(second.data.created, false);
    assert.equal(second.data.agent_id, first.data.agent_id);
    assert.equal(st.agents.size, 1, 'still one agent');
    assert.equal(st.tools.size, 6, 'still six tools');
    assert.equal(st.secrets, 1, 'the workspace secret is made once');

    const [a, b] = await Promise.all([provision({ action: 'create' }), provision({ action: 'create' })]);
    assert.ok([a.status, b.status].every(s => s === 200 || s === 409));
    assert.equal(st.agents.size, 1, 'concurrent creates never make a second agent');
  });

  test('owner edits opening hours in the panel: the live prompt is updated in the same request', async () => {
    const before = dev.mock.requests.length;
    const current = (await dev.call('GET', '/api/settings', { headers: { cookie: sid } })).data.settings;
    const r = await dev.call('PUT', '/api/settings', { body: { opening_hours: { ...current.opening_hours, sun: [['11:00', '15:00']] } }, headers: { cookie: sid } });
    assert.equal(r.status, 200);
    assert.equal(r.data.needs_sync, false, 'synced, no banner');
    const patch = dev.mock.requests.slice(before).find(q => q.method === 'PATCH' && q.url.startsWith('/v1/convai/agents/'));
    assert.ok(patch, 'agent PATCHed');
    assert.match(patch.body.conversation_config.agent.prompt.prompt, /Sunday: 11:00 to 15:00/);
    const quiet = await dev.admin('POST', `/admin/b/${BIZ}/provision`, { action: 'sync' });
    assert.deepEqual([quiet.data.synced, quiet.data.reason], [false, 'unchanged']);
  });

  test('attach a number: existing, then bought; re-attaching does not import twice', async () => {
    const existing = await provision({ action: 'attach-number', phone_number: '+447700900999' });
    assert.equal(existing.status, 200, JSON.stringify(existing.data));
    const pn = st.numbers.get(existing.data.phone_number_id);
    assert.deepEqual([pn.provider, pn.phone_number, pn.agent_id, pn.sid], ['twilio', '+447700900999', [...st.agents.keys()][0], 'ACtest']);
    await provision({ action: 'attach-number', phone_number: '+447700900999' });
    assert.equal(st.numbers.size, 1);

    const bought = await provision({ action: 'attach-number', buy: true });
    assert.equal(bought.data.phone_number, '+442071234567');
    const buy = dev.mock.requests.find(q => q.url.endsWith('/IncomingPhoneNumbers.json'));
    assert.deepEqual([buy.body.PhoneNumber, buy.body.BundleSid, buy.body.AddressSid], ['+442071234567', 'BU1', 'AD1']);
    assert.equal(st.numbers.size, 2);
  });

  test('pause/resume: message-only prompt pushed; the usage rules do not undo a team pause', async () => {
    await provision({ action: 'pause' });
    const agent = [...st.agents.values()][0];
    assert.match(agent.conversation_config.agent.prompt.prompt, /bookings by phone are paused/);
    assert.equal((await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: nextWeekday('thu') })).error, 'message_only');
    await dev.admin('PUT', '/admin/subscriptions', { business_id: BIZ, plan_id: 'basic', status: 'active', period_start: '2026-01-01', period_end: '2099-01-01' });
    await dev.cron('7 * * * *');
    assert.equal((await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: nextWeekday('thu') })).error, 'message_only');
    await provision({ action: 'resume' });
    assert.doesNotMatch([...st.agents.values()][0].conversation_config.agent.prompt.prompt, /bookings by phone are paused/);
    assert.equal((await dev.tool(BIZ, 'availability', { service_id: 'mens-cut', date: nextWeekday('thu') })).ok, true);
  });

  test('daily drift check reports a dashboard edit to the team chat', async () => {
    const [id, agent] = [...st.agents.entries()][0];
    agent.conversation_config.agent.prompt.prompt = 'Edited by hand in the dashboard';
    st.agents.set(id, agent);
    await dev.cron('17 3 * * *');
    const alert = await dev.until(() => dev.mock.of('telegram').find(m => m.body.chat_id === 'team-chat' && /Agent drift/.test(m.body.text)));
    assert.match(alert.body.text, new RegExp(`${BIZ}: conversation_config.agent.prompt.prompt`));
    await provision({ action: 'sync', force: true });
    assert.match(st.agents.get(id).conversation_config.agent.prompt.prompt, /Pars Barbers/);
  });

  test('delete removes agent, tools and number link', async () => {
    const r = await provision({ action: 'delete' });
    assert.equal(r.data.deleted, true);
    assert.deepEqual([st.agents.size, st.tools.size], [0, 0]);
    assert.equal((await provision({ action: 'sync' })).data.error, 'no_agent');
  });
});

describe('provisioning without a bundle or configuration', () => {
  let dev;
  before(async () => {
    dev = await startDev({ varsFromMock: PROVISIONING });
    fakePlatform(dev.mock);
    await seedBusiness(dev);
  });
  after(() => dev?.stop());

  test('buying a UK number explains the missing Regulatory Bundle', async () => {
    await dev.admin('POST', `/admin/b/${BIZ}/provision`, { action: 'create' });
    const r = await dev.admin('POST', `/admin/b/${BIZ}/provision`, { action: 'attach-number', buy: true });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'uk_bundle_missing');
    assert.match(r.data.message, /Regulatory Bundle/);
    assert.equal((await dev.admin('POST', `/admin/b/${BIZ}/provision`, { action: 'fly' })).data.error, 'bad_action');
  });
});
