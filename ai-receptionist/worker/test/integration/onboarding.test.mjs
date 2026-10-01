// Integration (M8): landing page API, self-serve sign-up, the onboarding wizard, preview agent + number,
// funnel counters and the day-10 trial reminder.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startDev, SECRETS } from './dev.mjs';
import { fakePlatform } from './fakes.mjs';

let dev, platform, sid, bizId;
const PHONE = '07700900851';
const panel = (method, path, body) => dev.call(method, path, { body, headers: { cookie: sid } });
const publicPost = (path, body, ip = '203.0.113.7') => dev.call('POST', path, { body, headers: { 'cf-connecting-ip': ip } });
const teamTexts = () => dev.mock.of('telegram').filter(m => m.body.chat_id === 'team-chat').map(m => m.body.text);

before(async () => {
  dev = await startDev({
    vars: { TWILIO_BUNDLE_SID: 'BU1', TWILIO_ADDRESS_SID: 'AD1', DEMO_NUMBER: '+442071230000', TEAM_ALERT_CHAT_ID: 'team-chat' },
    varsFromMock: u => ({
      ELEVENLABS_API_BASE: u, WORKER_PUBLIC_URL: 'https://receptionist.example',
      ELEVENLABS_VOICES: JSON.stringify({ en: 'v_en', fa: 'v_fa', options: [{ id: 'v_fa', lang: 'fa', label_fa: 'سارا', label_en: 'Sara', sample_url: '/audio/v_fa.mp3' }] }),
    }),
  });
  platform = fakePlatform(dev.mock);
});
after(() => dev?.stop());

test('landing page data: config and pricing come from the server', async () => {
  const c = (await dev.call('GET', '/api/public/config')).data;
  assert.deepEqual([c.demo_number, c.trial_days, c.voices[0].id], ['+442071230000', 14, 'v_fa']);
  const p = (await dev.call('GET', '/api/public/plans')).data.plans;
  assert.deepEqual(p.map(x => [x.id, x.monthly_price]), [['basic', 7900], ['pro', 14900]]);
  assert.equal((await dev.call('GET', '/health')).data.ok, true);
});

test('page events are counted, at most once per visitor per hour', async () => {
  for (let i = 0; i < 3; i++) await publicPost('/api/public/event', { event: 'visit' });
  await publicPost('/api/public/event', { event: 'visit' }, '203.0.113.8');
  await publicPost('/api/public/event', { event: 'demo_call' });
  assert.equal((await publicPost('/api/public/event', { event: 'paid' })).status, 400, 'business steps cannot be faked from the page');
  const f = (await dev.admin('GET', '/admin/funnel')).data.steps;
  assert.deepEqual(f.slice(0, 2).map(s => [s.event, s.count]), [['visit', 2], ['demo_call', 1]]);
});

test('contact form reaches the team chat', async () => {
  assert.equal((await publicPost('/api/public/contact', { name: 'Reza', contact: '07700900852', message: 'Do you work with clinics?' })).status, 200);
  await dev.until(() => teamTexts().some(t => /Website contact from Reza/.test(t)));
  assert.equal((await publicPost('/api/public/contact', { name: 'x' })).status, 400);
});

test('sign-up creates an inactive business, owner and 14-day trial, and texts a login code', async () => {
  assert.equal((await publicPost('/api/public/signup', { business_name: 'Shiraz Salon', owner_name: 'Maryam', phone: '123' })).data.error, 'bad_phone');
  const r = await publicPost('/api/public/signup', { business_name: 'Shiraz Salon', owner_name: 'Maryam', phone: PHONE, business_type: 'hair salon' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sms = await dev.until(() => dev.mock.of('sms').find(m => m.body.To === '+447700900851'));
  const v = await dev.call('POST', '/api/auth/verify', { body: { identifier: PHONE, code: /(\d{6})/.exec(sms.body.Body)[1] } });
  assert.equal(v.status, 200);
  sid = v.headers.get('set-cookie').split(';')[0];
  const me = (await panel('GET', '/api/me')).data.business;
  bizId = me.id;
  assert.match(bizId, /^shiraz-salon-[0-9a-f]{6}$/);
  assert.equal(me.onboarded, false);
  const account = (await panel('GET', '/api/account')).data.usage;
  assert.equal(account.status, 'trial');
  const health = (await dev.admin('GET', '/admin/health')).data.businesses.find(b => b.business_id === bizId);
  assert.equal(health.active, false, 'no alerts or self-tests until the wizard is done');

  // Signing up again with the same number creates nothing new.
  await publicPost('/api/public/signup', { business_name: 'Other', owner_name: 'M', phone: PHONE }, '203.0.113.9');
  assert.equal((await dev.admin('GET', '/admin/funnel')).data.steps.find(s => s.event === 'signup').count, 1);
});

test('wizard: invalid input is refused; finishing needs a complete profile', async () => {
  const start = (await panel('GET', '/api/onboarding')).data;
  assert.equal(start.profile.business_name, 'Shiraz Salon');
  assert.equal(start.voices[0].id, 'v_fa');

  const bad = await panel('PUT', '/api/onboarding', { opening_hours: { mon: [['18:00', '10:00']] }, business_type: 'castle' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.data.errors.map(e => e.field).sort(), ['business_type', 'opening_hours.mon']);

  const early = await panel('POST', '/api/onboarding/finish', {});
  assert.equal(early.status, 400);
  assert.deepEqual(early.data.errors.map(e => e.field).sort(), ['address', 'city', 'services']);
});

test('wizard finish: trial agent and preview number, forwarding, first call', async () => {
  const steps = [
    { address: '5 Example Street, London W1 1AA', city: 'London', nearest_station: 'Oxford Circus', assistant_name: 'Sara' },
    { opening_hours: { mon: [], tue: [['10:00', '19:00']], wed: [['10:00', '19:00']], thu: [['10:00', '20:00']], fri: [['10:00', '20:00']], sat: [['09:00', '18:00']], sun: [] } },
    { services: [{ id: 'cut-blow-dry', name_en: 'Cut and blow-dry', name_fa: 'کوتاهی و براشینگ', duration_min: 60, price: 45 }], capacity: 2 },
    { policies: ['Please cancel 24 hours ahead.'], faq: [{ q: 'Do you do colour?', a: 'Yes, ask for a consultation.' }] },
    { phone_for_transfer: '07700900853', transfer_hours: 'Tuesday to Saturday, 10:00 to 18:00' },
    { voice_id_fa: 'v_fa' },
  ];
  for (const s of steps) assert.equal((await panel('PUT', '/api/onboarding', s)).status, 200);

  const done = await panel('POST', '/api/onboarding/finish', {});
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual([done.data.agent, done.data.phone_number, done.data.number_pending], [true, '+442071234567', null]);
  const agent = [...platform.agents.values()][0];
  assert.match(agent.conversation_config.agent.prompt.prompt, /Shiraz Salon/);
  assert.doesNotMatch(agent.conversation_config.agent.prompt.prompt, /\{\{(?!system__)\w+\}\}|undefined/);
  assert.equal(agent.conversation_config.language_presets.fa.overrides.tts.voice_id, 'v_fa');
  const me = (await panel('GET', '/api/me')).data.business;
  assert.deepEqual([me.onboarded, me.phone_number], [true, '+442071234567']);

  assert.equal((await panel('POST', '/api/onboarding/forwarding', {})).status, 200);

  const agentId = [...platform.agents.keys()][0];
  const raw = JSON.stringify({ type: 'post_call_transcription', data: { agent_id: agentId, conversation_id: 'preview_1', metadata: { call_duration_secs: 40 }, analysis: {}, transcript: [] } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v0=${createHmac('sha256', SECRETS.ELEVENLABS_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex')}`;
  assert.equal((await fetch(`${dev.url}/webhooks/post-call`, { method: 'POST', headers: { 'elevenlabs-signature': sig }, body: raw })).status, 200);

  const funnel = await dev.until(async () => {
    const steps = (await dev.admin('GET', '/admin/funnel')).data.steps;
    return steps.find(s => s.event === 'preview_call').count === 1 ? steps : null;
  });
  assert.deepEqual(funnel.map(s => s.count), [2, 1, 1, 1, 1, 1, 0]);
  assert.equal(funnel.find(s => s.event === 'signup').from_previous, 100);
});

test('day-10 reminder with usage stats, sent once', async () => {
  const in4 = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
  await dev.admin('PUT', '/admin/subscriptions', { business_id: bizId, plan_id: 'basic', status: 'trial', period_start: new Date().toISOString().slice(0, 10), period_end: in4, trial_end: in4 });
  dev.mock.clear();
  await dev.cron('17 3 * * *');
  await dev.cron('17 3 * * *');
  await new Promise(r => setTimeout(r, 300));
  const reminders = dev.mock.of('sms').filter(m => m.body.To === '+447700900851' && /4 days of your trial/.test(m.body.Body));
  assert.equal(reminders.length, 1);
  assert.match(reminders[0].body.Body, /1 calls, 0 bookings, 0 messages/);
});

test('without a UK bundle the wizard still finishes and the team is told', async () => {
  // A second business, finished while Twilio refuses to sell (no available numbers): number is pending.
  dev.mock.routes.unshift(({ url }) => (url.includes('/AvailablePhoneNumbers/') ? { body: { available_phone_numbers: [] } } : undefined));
  await publicPost('/api/public/signup', { business_name: 'Tabriz Kebab', owner_name: 'Ali', phone: '07700900854', business_type: 'restaurant' }, '203.0.113.10');
  const sms = await dev.until(() => dev.mock.of('sms').find(m => m.body.To === '+447700900854'));
  const v = await dev.call('POST', '/api/auth/verify', { body: { identifier: '07700900854', code: /(\d{6})/.exec(sms.body.Body)[1] } });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  const put = body => dev.call('PUT', '/api/onboarding', { body, headers: { cookie } });
  await put({ address: '1 High St', city: 'Manchester', services: [{ id: 'table', name_en: 'Table booking', name_fa: 'رزرو میز', duration_min: 90, price: 0 }] });
  const r = await dev.call('POST', '/api/onboarding/finish', { body: {}, headers: { cookie } });
  assert.deepEqual([r.data.agent, r.data.phone_number, r.data.number_pending], [true, null, 'no_numbers']);
  await dev.until(() => teamTexts().some(t => /Tabriz Kebab .* number pending \(no_numbers\)/.test(t)));
});
