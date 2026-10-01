// Integration (M3): login by one-time code, session cookie, strict business scoping, and the panel actions
// the acceptance criteria name (walk-in respected by the AI, edit opening hours, read yesterday's calls).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startDev, seedBusiness, nextWeekday, SECRETS } from './dev.mjs';

let dev;
const A = 'biz-a', B = 'biz-b';
const OWNER_A = '07700900801', STAFF_A = '07700900802', OWNER_B = '07700900803';

before(async () => {
  dev = await startDev();
  await seedBusiness(dev, { business_id: A, business_name: 'Shop A' }, 'agent_a');
  await seedBusiness(dev, { business_id: B, business_name: 'Shop B' }, 'agent_b');
  for (const [business_id, phone, role, name] of [[A, OWNER_A, 'owner', 'Ali'], [A, STAFF_A, 'staff', 'Sara'], [B, OWNER_B, 'owner', 'Bita']]) {
    assert.equal((await dev.admin('PUT', '/admin/users', { business_id, name, phone, role })).status, 200);
  }
  await dev.admin('PUT', '/admin/users', { name: 'Team', email: 'team@example.com', role: 'superadmin' });
});
after(() => dev?.stop());

/** Log in through the real flow: request a code, read it from the mock SMS/email, verify, keep the cookie. */
async function login(identifier) {
  const before = dev.mock.requests.length;
  const r = await dev.call('POST', '/api/auth/request-code', { body: { identifier } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const msg = await dev.until(() => dev.mock.requests.slice(before).find(m => m.service === 'sms' || m.service === 'email'));
  const code = /(\d{6})/.exec(msg.body.Body || msg.body.text)[1];
  const v = await dev.call('POST', '/api/auth/verify', { body: { identifier, code } });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  const cookie = v.headers.get('set-cookie');
  assert.match(cookie, /^sid=[\w-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  const sid = cookie.split(';')[0];
  return (method, path, body, headers = {}) => dev.call(method, path, { body, headers: { cookie: sid, ...headers } });
}

let ownerA, staffA, ownerB, team;

test('login: code by SMS and email, wrong codes, no account enumeration', async () => {
  ownerA = await login(OWNER_A);
  staffA = await login('+44 7700 900802');
  ownerB = await login(OWNER_B);
  team = await login('Team@Example.com');

  const unknown = await dev.call('POST', '/api/auth/request-code', { body: { identifier: '07700900999' } });
  assert.deepEqual([unknown.status, unknown.data.ok], [200, true], 'same answer for unknown numbers');

  // Five wrong guesses kill the code, even if the sixth is right.
  await dev.call('POST', '/api/auth/request-code', { body: { identifier: OWNER_B } });
  const sms = await dev.until(() => dev.mock.of('sms').filter(m => m.body.To === '+447700900803').at(-1));
  const good = /(\d{6})/.exec(sms.body.Body)[1];
  const wrong = good === '000000' ? '111111' : '000000';
  const errors = [];
  for (let i = 0; i < 5; i++) errors.push((await dev.call('POST', '/api/auth/verify', { body: { identifier: OWNER_B, code: wrong } })).data.error);
  assert.deepEqual(errors, ['bad_code', 'bad_code', 'bad_code', 'bad_code', 'too_many_attempts']);
  const late = await dev.call('POST', '/api/auth/verify', { body: { identifier: OWNER_B, code: good } });
  assert.equal(late.status, 401);
});

test('login code requests are rate-limited per number', async () => {
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await dev.call('POST', '/api/auth/request-code', { body: { identifier: '07700900888' } })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

test('no session, no access; JSON required for writes', async () => {
  assert.equal((await dev.call('GET', '/api/today')).status, 401);
  assert.equal((await dev.call('GET', '/api/today', { headers: { cookie: 'sid=forged' } })).status, 401);
  const form = await dev.call('POST', '/api/bookings', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
});

test('cross-business access is denied on every business route', async () => {
  const thu = nextWeekday('thu');
  const call = createHmac('sha256', 'x').digest('hex'); // any id
  const routes = [
    ['GET', '/api/me'], ['GET', '/api/today'], ['GET', '/api/bookings'], ['GET', `/api/availability?service_id=mens-cut&date=${thu}`],
    ['POST', '/api/bookings', { service_id: 'mens-cut', date: thu, time: '12:00', customer_name: 'X' }],
    ['POST', '/api/bookings/ABCDEF/cancel', {}], ['POST', '/api/bookings/ABCDEF/move', { date: thu, time: '13:00' }],
    ['GET', '/api/calls'], ['GET', `/api/calls/${call}`], ['GET', `/api/calls/${call}/audio`],
    ['GET', '/api/messages'], ['POST', '/api/messages/1/done', { done: true }],
    ['GET', '/api/settings'], ['PUT', '/api/settings', { capacity: 3 }],
    ['GET', '/api/account'], ['POST', '/api/users', { name: 'X', phone: '07700900877' }], ['DELETE', '/api/users/1'],
  ];
  for (const [method, path, body] of routes) {
    const viaHeader = await ownerA(method, path, body, { 'x-business-id': B });
    assert.equal(viaHeader.status, 403, `${method} ${path} with x-business-id`);
    const viaQuery = await ownerA(method, path + (path.includes('?') ? '&' : '?') + `b=${B}`, body);
    assert.equal(viaQuery.status, 403, `${method} ${path} with ?b=`);
  }
  assert.equal((await ownerA('GET', '/api/businesses')).status, 403, 'only superadmin lists businesses');
});

test('ids from another business are not found, even without asking for it', async () => {
  const thu = nextWeekday('thu');
  const bBooking = await dev.tool(B, 'book', { service_id: 'mens-cut', date: thu, time: '10:00', customer_name: 'Other', customer_phone: '07700900870', language: 'en' });
  assert.equal((await ownerA('POST', `/api/bookings/${bBooking.booking_id}/cancel`, {})).status, 404);
  await dev.tool(B, 'message', { caller_name: 'X', caller_phone: '07700900871', message: 'for B', urgency: 'normal' });
  const bMsg = (await ownerB('GET', '/api/messages')).data.messages[0];
  assert.equal((await ownerA('POST', `/api/messages/${bMsg.id}/done`, { done: true })).status, 404);
  assert.ok(!(await ownerA('GET', '/api/messages')).data.messages.some(m => m.id === bMsg.id));
  const bUsers = (await ownerB('GET', '/api/account')).data.users;
  assert.equal((await ownerA('DELETE', `/api/users/${bUsers[0].id}`)).status, 404);
});

test('superadmin chooses a business; staff cannot change settings or users', async () => {
  assert.equal((await team('GET', '/api/today')).status, 400);
  assert.equal((await team('GET', '/api/businesses')).data.businesses.length, 2);
  assert.equal((await team('GET', '/api/settings', undefined, { 'x-business-id': B })).status, 200);
  assert.equal((await staffA('PUT', '/api/settings', { capacity: 3 })).status, 403);
  assert.equal((await staffA('POST', '/api/users', { name: 'X', phone: '07700900876' })).status, 403);
  assert.deepEqual((await staffA('GET', '/api/account')).data.users, []);
  assert.equal((await staffA('GET', '/api/today')).status, 200, 'staff work the diary');
});

test('walk-in from the panel is respected by the AI', async () => {
  const thu = nextWeekday('thu');
  const seen = async () => (await dev.tool(A, 'availability', { service_id: 'mens-cut', date: thu, preferred_time: '11:00' })).slots;
  assert.ok((await seen()).includes('11:00'));
  for (const name of ['Walk-in 1', 'Walk-in 2']) { // capacity 2
    const r = await staffA('POST', '/api/bookings', { service_id: 'mens-cut', date: thu, time: '11:00', customer_name: name });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.booking.source, 'panel');
    assert.equal(r.data.booking.customer_phone, null, 'walk-ins need no phone');
  }
  assert.ok(!(await seen()).includes('11:00'), 'the AI no longer offers 11:00');
  const third = await staffA('POST', '/api/bookings', { service_id: 'mens-cut', date: thu, time: '11:00', customer_name: 'Too many' });
  assert.deepEqual([third.status, third.data.error], [409, 'slot_taken']);
  const agent = await dev.tool(A, 'book', { service_id: 'mens-cut', date: thu, time: '11:00', customer_name: 'Caller', customer_phone: '07700900811', language: 'fa' });
  assert.equal(agent.error, 'slot_taken');

  const week = await ownerA('GET', `/api/bookings?from=${thu}&days=7`);
  const walkIn = week.data.bookings.find(b => b.customer_name === 'Walk-in 1');
  const moved = await ownerA('POST', `/api/bookings/${walkIn.id}/move`, { date: thu, time: '12:00' });
  assert.equal(moved.data.booking.time, '12:00');
  assert.ok((await seen()).includes('11:00'), 'moving one frees a place');
  const cancelled = await ownerA('POST', `/api/bookings/${walkIn.id}/cancel`, {});
  assert.equal(cancelled.data.booking.status, 'cancelled');
});

test('owner edits opening hours: validated, saved, agent marked for sync, AI uses them', async () => {
  const sun = nextWeekday('sun');
  const bad = await ownerA('PUT', '/api/settings', { opening_hours: { sun: [['14:00', '12:00']] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.errors[0].field, 'opening_hours.sun');

  const current = (await ownerA('GET', '/api/settings')).data;
  assert.equal(current.needs_sync, false);
  const hours = { ...current.settings.opening_hours, sun: [['11:00', '15:00']] };
  const r = await ownerA('PUT', '/api/settings', { opening_hours: hours });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.needs_sync, true);
  assert.equal((await ownerA('GET', '/api/me')).data.business.needs_sync, true);
  const avail = await dev.tool(A, 'availability', { service_id: 'mens-cut', date: sun });
  assert.equal(avail.slots[0], '11:00', 'Sunday is now open for the AI too');
  // Other profile fields are untouched.
  assert.equal((await ownerA('GET', '/api/settings')).data.settings.services.length, 4);
});

test("calls: list, detail with transcript, recording proxied", async () => {
  const event = {
    type: 'post_call_transcription',
    data: {
      agent_id: 'agent_a', conversation_id: 'conv_a1',
      metadata: { call_duration_secs: 130, phone_call: { external_number: '+447700900812' } },
      analysis: { transcript_summary: 'Asked about prices.', call_successful: 'success', data_collection_results: { language: { value: 'fa' }, caller_intent: { value: 'question' } } },
      transcript: [{ role: 'agent', message: 'سلام' }, { role: 'user', message: 'قیمت؟' }],
    },
  };
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v0=${createHmac('sha256', SECRETS.ELEVENLABS_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex')}`;
  assert.equal((await fetch(`${dev.url}/webhooks/post-call`, { method: 'POST', headers: { 'elevenlabs-signature': sig }, body: raw })).status, 200);

  const list = await ownerA('GET', '/api/calls');
  assert.deepEqual([list.data.calls[0].id, list.data.calls[0].language, list.data.calls[0].intent], ['conv_a1', 'fa', 'question']);
  const detail = await ownerA('GET', '/api/calls/conv_a1');
  assert.equal(detail.data.call.transcript.length, 2);
  assert.equal(detail.data.call.audio, true);
  const audio = await ownerA('GET', '/api/calls/conv_a1/audio');
  assert.equal(audio.status, 200);
  assert.ok(dev.mock.requests.some(m => m.url === '/v1/convai/conversations/conv_a1/audio'));
  assert.equal((await ownerB('GET', '/api/calls/conv_a1')).status, 404);

  const today = await ownerA('GET', '/api/today');
  assert.equal(today.data.calls_today, 1);
  assert.equal(today.data.usage.minutes_used, 3, '130 s rounds up to 3 minutes');
});

test('messages: unread count and mark done', async () => {
  await dev.tool(A, 'message', { caller_name: 'Reza', caller_phone: '07700900813', message: 'Call back please', urgency: 'normal' });
  const today = await ownerA('GET', '/api/today');
  assert.equal(today.data.unread_messages, 1);
  const [msg] = (await ownerA('GET', '/api/messages')).data.messages;
  assert.equal((await ownerA('POST', `/api/messages/${msg.id}/done`, { done: true })).status, 200);
  assert.equal((await ownerA('GET', '/api/today')).data.unread_messages, 0);
  assert.equal((await ownerA('GET', '/api/messages?status=all')).data.messages.length, 1);
});

test('owner manages users; prefs; logout ends the session', async () => {
  const add = await ownerA('POST', '/api/users', { name: 'New staff', phone: '07700900814' });
  assert.equal(add.status, 201);
  assert.equal((await ownerA('POST', '/api/users', { name: 'Dup', phone: '07700900814' })).status, 409);
  assert.equal((await ownerA('DELETE', `/api/users/${add.data.user.id}`)).status, 200);
  const me = (await ownerA('GET', '/api/me')).data.user;
  assert.equal((await ownerA('DELETE', `/api/users/${me.id}`)).data.error, 'cannot_remove_self');

  const prefs = await ownerA('PUT', '/api/me/prefs', { lang: 'en', digits: 'latn' });
  assert.deepEqual(prefs.data.prefs, { lang: 'en', digits: 'latn' });

  const out = await ownerA('POST', '/api/auth/logout', {});
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await ownerA('GET', '/api/me')).status, 401);
});
