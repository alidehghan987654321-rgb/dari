import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webhookTools, agentRequest, agentDrift } from '../src/provision-build.js';

const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const profile = read('../../prompts/business_profile.example.json');
const template = read('../../config/agent_template.json');
const toolsConfig = read('../../config/tools.json');
const business = { id: 'pars-barbers', profile };

test('webhook tools: one per tool, business URL, secret header, required args', () => {
  const tools = webhookTools(toolsConfig, { workerUrl: 'https://w.example/', businessId: 'pars-barbers', secretId: 'sec_1' });
  assert.equal(tools.length, 6);
  const book = tools.find(t => t.tool_config.name === 'create_booking').tool_config;
  assert.equal(book.type, 'webhook');
  assert.equal(book.api_schema.url, 'https://w.example/b/pars-barbers/book');
  assert.deepEqual(book.api_schema.request_headers, { Authorization: { secret_id: 'sec_1' } });
  assert.deepEqual(book.api_schema.request_body_schema.required, ['service_id', 'date', 'time', 'customer_name', 'customer_phone', 'language']);
  assert.equal(book.api_schema.request_body_schema.properties.notes.type, 'string');
  assert.equal(tools.find(t => t.tool_config.name === 'find_bookings').tool_config.api_schema.url, 'https://w.example/b/pars-barbers/find-bookings');
});

test('agent request follows the template and the profile', () => {
  const body = agentRequest({ business, template, prompt: 'PROMPT', firstMessage: 'HELLO', toolIds: ['t1', 't2'], voices: { en: 'v_en', fa: 'v_fa' }, postCallWebhookId: 'wh_1' });
  const agent = body.conversation_config.agent;
  assert.equal(agent.prompt.prompt, 'PROMPT');
  assert.equal(agent.prompt.llm, 'claude-sonnet-5');
  assert.ok(!('temperature' in agent.prompt), 'no sampling override for Claude 5 models');
  assert.deepEqual(agent.prompt.tool_ids, ['t1', 't2']);
  assert.deepEqual(Object.keys(agent.prompt.built_in_tools).sort(), ['end_call', 'language_detection', 'skip_turn', 'transfer_to_number']);
  assert.deepEqual(agent.prompt.built_in_tools.transfer_to_number.params.transfers[0].transfer_destination, { type: 'phone', phone_number: '+447700900000' });
  assert.equal(agent.prompt.built_in_tools.end_call.params.system_tool_type, 'end_call');
  assert.equal(agent.first_message, 'HELLO');
  assert.equal(body.conversation_config.tts.voice_id, 'v_en');
  assert.equal(body.conversation_config.tts.agent_output_audio_format, 'ulaw_8000');
  assert.deepEqual(body.conversation_config.language_presets.fa, { overrides: { agent: { language: 'fa' }, tts: { voice_id: 'v_fa' } } });
  assert.equal(body.conversation_config.turn.turn_timeout, 7);
  assert.equal(body.conversation_config.conversation.max_duration_seconds, 600);
  assert.ok(body.conversation_config.asr.keywords.includes('Pars Barbers'));
  assert.equal(body.platform_settings.workspace_overrides.webhooks.post_call_webhook_id, 'wh_1');
  assert.equal(body.platform_settings.privacy.retention_days, 90);
  assert.equal(body.platform_settings.evaluation.criteria[0].type, 'prompt');
  assert.ok(body.tags.includes('business:pars-barbers'));

  const noTransfer = agentRequest({ business: { id: 'x', profile: { ...profile, phone_for_transfer: '' } }, template, prompt: 'P', firstMessage: 'H', toolIds: [] });
  assert.ok(!('transfer_to_number' in noTransfer.conversation_config.agent.prompt.built_in_tools));
  assert.ok(!('workspace_overrides' in noTransfer.platform_settings));
  const ownVoice = agentRequest({ business: { id: 'x', profile: { ...profile, voice_id: 'v_owner' } }, template, prompt: 'P', firstMessage: 'H', toolIds: [], voices: { en: 'v_en' } });
  assert.equal(ownVoice.conversation_config.tts.voice_id, 'v_owner');
});

test('drift: only the fields we own', () => {
  const expected = agentRequest({ business, template, prompt: 'P1', firstMessage: 'H', toolIds: ['a', 'b'] });
  const live = structuredClone(expected);
  live.conversation_config.agent.prompt.tool_ids = ['b', 'a']; // order does not matter
  live.platform_settings.widget = { anything: true };          // fields we do not own are ignored
  assert.deepEqual(agentDrift(live, expected), []);
  live.conversation_config.agent.prompt.prompt = 'edited in the dashboard';
  live.conversation_config.agent.prompt.tool_ids = ['a'];
  assert.deepEqual(agentDrift(live, expected), ['conversation_config.agent.prompt.prompt', 'conversation_config.agent.prompt.tool_ids']);
});
