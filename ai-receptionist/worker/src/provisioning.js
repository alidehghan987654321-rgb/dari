// M5 — automatic agent provisioning. Every operation is idempotent and callable from the admin API, the CLI
// (ai-receptionist/provisioning/cli.mjs, through the admin API) and internally (panel save, usage rules).
//
// Vars/secrets: ELEVENLABS_API_KEY, WORKER_PUBLIC_URL (the URL tools call), ELEVENLABS_POST_CALL_WEBHOOK_ID,
// ELEVENLABS_VOICES ('{"en":"<voice id>","fa":"<voice id>"}'), TWILIO_* (and TWILIO_BUNDLE_SID +
// TWILIO_ADDRESS_SID to buy UK numbers). ELEVENLABS_API_BASE only for tests.

import TEMPLATE_MD from '../../prompts/system_prompt.template.md';
import FIRST_MESSAGE_MD from '../../prompts/first_message.md';
import AGENT_TEMPLATE from '../../config/agent_template.json';
import TOOLS_CONFIG from '../../config/tools.json';
import { render, firstMessageFrom, promptHash } from '../../shared/prompt-core.mjs';
import { webhookTools, agentRequest, agentDrift } from './provision-build.js';
import { loadBusiness } from './bookings.js';
import { sendTeamAlert } from './notify.js';

export class ProvisionError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export const provisioningConfigured = env => !!(env.ELEVENLABS_API_KEY && env.WORKER_PUBLIC_URL);

const xiBase = env => (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/$/, '');
const twilioBase = env => (env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');

async function xi(env, method, path, body) {
  const r = await fetch(`${xiBase(env)}${path}`, {
    method,
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 404) return null;
  const text = await r.text();
  if (!r.ok) throw new ProvisionError('elevenlabs_error', `ElevenLabs ${method} ${path.replace(/[?].*/, '')} -> ${r.status}: ${text.slice(0, 300)}`, 502);
  return text ? JSON.parse(text) : {};
}

async function twilio(env, method, path, form) {
  const r = await fetch(`${twilioBase(env)}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}${path}`, {
    method,
    headers: { authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ProvisionError('twilio_error', `Twilio ${path.replace(/[?].*/, '')} -> ${r.status}: ${data.message || ''}`, 502);
  return data;
}

async function setting(env, key) {
  return (await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first())?.value ?? null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, value).run();
}

function requireConfigured(env) {
  if (!provisioningConfigured(env)) throw new ProvisionError('not_configured', 'Set ELEVENLABS_API_KEY and WORKER_PUBLIC_URL first.', 400);
}

async function requireBusiness(env, id) {
  const b = await loadBusiness(env, id);
  if (!b) throw new ProvisionError('unknown_business', `No business ${id}.`, 404);
  const row = await env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(id).first();
  return { ...b, row };
}

const voices = env => { try { return JSON.parse(env.ELEVENLABS_VOICES || '{}'); } catch { return {}; } };

/** What we would push for this business right now. */
export function desiredAgent(env, business, toolIds) {
  const prompt = render(TEMPLATE_MD, business.profile);
  return {
    hash: `${AGENT_TEMPLATE.template_version}:${promptHash(prompt)}:${promptHash(JSON.stringify(toolIds))}:${business.profile.phone_for_transfer || ''}:${business.profile.voice_id || ''}`,
    body: agentRequest({
      business, template: AGENT_TEMPLATE, prompt, firstMessage: firstMessageFrom(FIRST_MESSAGE_MD, business.profile),
      toolIds, voices: voices(env), postCallWebhookId: env.ELEVENLABS_POST_CALL_WEBHOOK_ID || null,
    }),
  };
}

/** One-off: the workspace secret that holds "Bearer <TOOL_SECRET>" for the tools' Authorization header. */
export async function setup(env) {
  requireConfigured(env);
  let secretId = await setting(env, 'elevenlabs_tool_secret_id');
  if (!secretId) {
    const r = await xi(env, 'POST', '/v1/convai/secrets', { type: 'new', name: 'receptionist_tool_secret', value: `Bearer ${env.TOOL_SECRET}` });
    secretId = r.secret_id;
    await setSetting(env, 'elevenlabs_tool_secret_id', secretId);
  }
  return { secret_id: secretId };
}

/** Create the business's 6 webhook tools, or update them when the template version changed. */
async function ensureTools(env, business) {
  const { secret_id } = await setup(env);
  const bodies = webhookTools(TOOLS_CONFIG, { workerUrl: env.WORKER_PUBLIC_URL, businessId: business.id, secretId: secret_id, timeoutSecs: AGENT_TEMPLATE.tool_response_timeout_secs });
  let ids = business.row.tool_ids_json ? JSON.parse(business.row.tool_ids_json) : null;
  if (ids && ids.length === bodies.length) {
    if (business.row.template_version !== AGENT_TEMPLATE.template_version) {
      for (let i = 0; i < ids.length; i++) {
        if (!(await xi(env, 'PATCH', `/v1/convai/tools/${ids[i]}`, bodies[i]))) ids[i] = (await xi(env, 'POST', '/v1/convai/tools', bodies[i])).id;
      }
    }
  } else {
    ids = [];
    for (const b of bodies) ids.push((await xi(env, 'POST', '/v1/convai/tools', b)).id);
  }
  await env.DB.prepare('UPDATE businesses SET tool_ids_json = ? WHERE id = ?').bind(JSON.stringify(ids), business.id).run();
  return ids;
}

async function markSynced(env, id, hash) {
  await env.DB.prepare(
    "UPDATE businesses SET prompt_hash = ?, template_version = ?, needs_sync = 0, synced_at = datetime('now') WHERE id = ?"
  ).bind(hash, AGENT_TEMPLATE.template_version, id).run();
}

/**
 * createAgent: idempotent. An existing, live agent is synced instead of duplicated; a concurrent create is
 * refused by a short lock.
 */
export async function createAgent(env, businessId) {
  requireConfigured(env);
  let business = await requireBusiness(env, businessId);
  if (business.agent_id) {
    if (await xi(env, 'GET', `/v1/convai/agents/${business.agent_id}`)) {
      return { ...(await syncAgent(env, businessId, { force: true })), created: false, agent_id: business.agent_id };
    }
    await env.DB.prepare('UPDATE businesses SET agent_id = NULL WHERE id = ?').bind(businessId).run(); // deleted on their side
  }
  const now = new Date();
  const lock = await env.DB.prepare(
    'UPDATE businesses SET provisioning_lock = ? WHERE id = ? AND agent_id IS NULL AND (provisioning_lock IS NULL OR provisioning_lock < ?)'
  ).bind(now.toISOString(), businessId, new Date(now - 120_000).toISOString()).run();
  if (lock.meta?.changes !== 1) throw new ProvisionError('busy', 'Another create is running for this business; try again in a minute.', 409);
  try {
    business = await requireBusiness(env, businessId);
    const toolIds = await ensureTools(env, business);
    const desired = desiredAgent(env, business, toolIds);
    const r = await xi(env, 'POST', '/v1/convai/agents/create', desired.body);
    await env.DB.prepare("UPDATE businesses SET agent_id = ?, provisioned_at = datetime('now') WHERE id = ?").bind(r.agent_id, businessId).run();
    await markSynced(env, businessId, desired.hash);
    return {
      created: true, agent_id: r.agent_id,
      next_steps: [
        business.row.phone_number ? null : 'Attach a phone number: action "attach-number" with { phone_number } or { buy: true }.',
        env.ELEVENLABS_POST_CALL_WEBHOOK_ID ? null : 'Set ELEVENLABS_POST_CALL_WEBHOOK_ID (create the post-call webhook once in the ElevenLabs dashboard) and sync.',
        voices(env).en ? null : 'Set ELEVENLABS_VOICES with the English and Persian voice ids and sync.',
      ].filter(Boolean),
    };
  } finally {
    await env.DB.prepare('UPDATE businesses SET provisioning_lock = NULL WHERE id = ?').bind(businessId).run();
  }
}

/** syncAgent: push the re-rendered prompt and settings. Skips when nothing changed (unless force). */
export async function syncAgent(env, businessId, { force = false } = {}) {
  requireConfigured(env);
  const business = await requireBusiness(env, businessId);
  if (!business.agent_id) throw new ProvisionError('no_agent', 'This business has no agent yet; create it first.', 409);
  const toolIds = await ensureTools(env, business);
  const desired = desiredAgent(env, business, toolIds);
  if (!force && business.row.prompt_hash === desired.hash && business.row.template_version === AGENT_TEMPLATE.template_version) {
    await markSynced(env, businessId, desired.hash);
    return { synced: false, reason: 'unchanged' };
  }
  const r = await xi(env, 'PATCH', `/v1/convai/agents/${business.agent_id}`, desired.body);
  if (!r) throw new ProvisionError('agent_missing', 'The agent no longer exists on ElevenLabs; run create again.', 409);
  await markSynced(env, businessId, desired.hash);
  return { synced: true };
}

/** Sync without throwing (panel saves and usage rules): failures are logged and left as needs_sync. */
export async function trySync(env, businessId) {
  if (!provisioningConfigured(env)) return null;
  try {
    const b = await env.DB.prepare('SELECT agent_id FROM businesses WHERE id = ?').bind(businessId).first();
    if (!b?.agent_id) return null;
    return await syncAgent(env, businessId);
  } catch (e) {
    console.error(JSON.stringify({ evt: 'sync_failed', business_id: businessId, error: String(e?.message || e) }));
    return null;
  }
}

/**
 * attachNumber: put a phone number on the agent. Either an existing Twilio number ({ phone_number }) or a new
 * local number bought through Twilio ({ buy: true }). UK numbers need an approved Regulatory Bundle.
 */
export async function attachNumber(env, businessId, { phone_number, buy = false } = {}) {
  requireConfigured(env);
  const business = await requireBusiness(env, businessId);
  if (!business.agent_id) throw new ProvisionError('no_agent', 'Create the agent first.', 409);
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) throw new ProvisionError('not_configured', 'Twilio credentials are not set.');

  let number = phone_number;
  if (buy) {
    const country = business.profile.country || 'GB';
    if (country === 'GB' && (!env.TWILIO_BUNDLE_SID || !env.TWILIO_ADDRESS_SID)) {
      throw new ProvisionError('uk_bundle_missing',
        'UK numbers need an approved Twilio Regulatory Bundle and an Address. Create them in the Twilio console, then set TWILIO_BUNDLE_SID and TWILIO_ADDRESS_SID.');
    }
    const found = await twilio(env, 'GET', `/AvailablePhoneNumbers/${country}/Local.json?VoiceEnabled=true&PageSize=1`);
    const pick = found.available_phone_numbers?.[0]?.phone_number;
    if (!pick) throw new ProvisionError('no_numbers', `Twilio has no local ${country} numbers available right now.`, 502);
    const form = { PhoneNumber: pick, FriendlyName: `Receptionist ${businessId}` };
    if (env.TWILIO_BUNDLE_SID) form.BundleSid = env.TWILIO_BUNDLE_SID;
    if (env.TWILIO_ADDRESS_SID) form.AddressSid = env.TWILIO_ADDRESS_SID;
    number = (await twilio(env, 'POST', '/IncomingPhoneNumbers.json', form)).phone_number;
  }
  if (!number || !/^\+\d{8,15}$/.test(number)) throw new ProvisionError('bad_number', 'Give phone_number in E.164 (+44...) or buy: true.');

  let numberId = business.row.phone_number_id;
  if (numberId && business.row.phone_number === number) {
    await xi(env, 'PATCH', `/v1/convai/phone-numbers/${numberId}`, { agent_id: business.agent_id });
  } else {
    numberId = (await xi(env, 'POST', '/v1/convai/phone-numbers', {
      provider: 'twilio', phone_number: number, label: `${business.profile.business_name} (${businessId})`,
      sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, agent_id: business.agent_id,
    })).phone_number_id;
  }
  await env.DB.prepare('UPDATE businesses SET phone_number = ?, phone_number_id = ? WHERE id = ?').bind(number, numberId, businessId).run();
  return { phone_number: number, phone_number_id: numberId, bought: !!buy };
}

/** pause/resume: message-only mode set by our team (kept until resumed; the usage rules never clear it). */
export async function setPaused(env, businessId, paused) {
  await requireBusiness(env, businessId);
  await env.DB.prepare('UPDATE businesses SET message_only = ?, message_only_reason = ? WHERE id = ?')
    .bind(paused ? 1 : 0, paused ? 'manual' : null, businessId).run();
  return { paused, sync: await trySync(env, businessId) };
}

/** deleteAgent: remove the agent, its tools and the phone number link on ElevenLabs. The Twilio number is kept. */
export async function deleteAgent(env, businessId) {
  requireConfigured(env);
  const business = await requireBusiness(env, businessId);
  if (business.row.phone_number_id) await xi(env, 'DELETE', `/v1/convai/phone-numbers/${business.row.phone_number_id}`);
  if (business.agent_id) await xi(env, 'DELETE', `/v1/convai/agents/${business.agent_id}`);
  for (const id of JSON.parse(business.row.tool_ids_json || '[]')) await xi(env, 'DELETE', `/v1/convai/tools/${id}`);
  await env.DB.prepare(
    'UPDATE businesses SET agent_id = NULL, tool_ids_json = NULL, phone_number_id = NULL, prompt_hash = NULL, template_version = NULL, synced_at = NULL WHERE id = ?'
  ).bind(businessId).run();
  return { deleted: true, kept_twilio_number: business.row.phone_number || null };
}

/** Daily: compare each live agent with what we would push; report differences to the team chat. */
export async function driftCheck(env) {
  if (!provisioningConfigured(env)) return [];
  const rows = (await env.DB.prepare('SELECT id FROM businesses WHERE agent_id IS NOT NULL AND active = 1').all()).results || [];
  const report = [];
  for (const { id } of rows) {
    try {
      const business = await requireBusiness(env, id);
      const live = await xi(env, 'GET', `/v1/convai/agents/${business.agent_id}`);
      if (!live) { report.push({ business_id: id, diff: ['agent_missing'] }); continue; }
      const diff = agentDrift(live, desiredAgent(env, business, JSON.parse(business.row.tool_ids_json || '[]')).body);
      if (diff.length) report.push({ business_id: id, diff });
    } catch (e) {
      report.push({ business_id: id, diff: [`check_failed: ${e.message}`] });
    }
  }
  if (report.length) {
    await sendTeamAlert(env, `🟠 Agent drift (live config differs from what we render):\n${report.map(r => `• ${r.business_id}: ${r.diff.join(', ')}`).join('\n')}\nFix: POST /admin/b/<id>/provision {"action":"sync","force":true}`);
  }
  return report;
}

/** Daily: agents of businesses cancelled longer than the retention period are deleted. */
export async function deleteExpiredAgents(env, now = new Date()) {
  if (!provisioningConfigured(env)) return [];
  const days = Number(env.RETENTION_DAYS || 90);
  const cutoff = new Date(now - days * 864e5).toISOString();
  const rows = (await env.DB.prepare(
    "SELECT b.id FROM businesses b JOIN subscriptions s ON s.business_id = b.id WHERE s.status = 'cancelled' AND s.status_changed_at < ? AND b.agent_id IS NOT NULL"
  ).bind(cutoff).all()).results || [];
  const done = [];
  for (const { id } of rows) {
    try { await deleteAgent(env, id); done.push(id); } catch (e) { console.error(JSON.stringify({ evt: 'delete_agent_failed', business_id: id, error: e.message })); }
  }
  return done;
}

/** Admin API dispatcher: POST /admin/b/:id/provision { action, ... }. */
export async function provisionAction(env, businessId, body) {
  switch (body.action) {
    case 'create': return createAgent(env, businessId);
    case 'sync': return syncAgent(env, businessId, { force: !!body.force });
    case 'attach-number': return attachNumber(env, businessId, body);
    case 'pause': return setPaused(env, businessId, true);
    case 'resume': return setPaused(env, businessId, false);
    case 'delete': return deleteAgent(env, businessId);
    default: throw new ProvisionError('bad_action', 'action must be create, sync, attach-number, pause, resume or delete.');
  }
}
