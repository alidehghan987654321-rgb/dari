// M5 — pure builders for the ElevenLabs Agents API (no I/O, unit-tested).
// Request shapes follow the official elevenlabs-js SDK (serialization types for agents/create, tools,
// phone-numbers). Check them against the current API reference when ElevenLabs ships changes.

/** Tool bodies for POST/PATCH /v1/convai/tools, one per webhook tool in config/tools.json. */
export function webhookTools(toolsConfig, { workerUrl, businessId, secretId, timeoutSecs = 10 }) {
  const base = workerUrl.replace(/\/$/, '');
  return toolsConfig.tools.map(t => {
    const required = [];
    const properties = {};
    for (const [k, v] of Object.entries(t.body)) {
      properties[k] = { type: v.type, description: v.description };
      if (v.required) required.push(k);
    }
    const path = t.url.split('/').pop();
    return {
      tool_config: {
        type: 'webhook',
        name: t.name,
        description: t.description,
        response_timeout_secs: timeoutSecs,
        api_schema: {
          url: `${base}/b/${businessId}/${path}`,
          method: 'POST',
          // The Authorization value lives in an ElevenLabs workspace secret ("Bearer <TOOL_SECRET>").
          request_headers: { Authorization: { secret_id: secretId } },
          request_body_schema: { type: 'object', description: `Arguments for ${t.name}.`, required, properties },
        },
      },
    };
  });
}

function systemTool(name, params, description = '') {
  return { type: 'system', name, description, params: { system_tool_type: name, ...params } };
}

/**
 * Body for POST /v1/convai/agents/create and PATCH /v1/convai/agents/{id}.
 * prompt / firstMessage: rendered text. toolIds: ids of this business's webhook tools.
 * voices: { en, fa } voice ids (profile.voice_id overrides the default for the main voice).
 */
export function agentRequest({ business, template, prompt, firstMessage, toolIds, voices = {}, postCallWebhookId = null }) {
  const p = business.profile;
  const builtIn = {
    end_call: systemTool('end_call', {}),
    language_detection: systemTool('language_detection', {}),
    skip_turn: systemTool('skip_turn', {}),
  };
  if (p.phone_for_transfer) {
    builtIn.transfer_to_number = systemTool('transfer_to_number', {
      transfers: [{ transfer_destination: { type: 'phone', phone_number: p.phone_for_transfer }, condition: template.transfer_condition }],
    });
  }
  const llm = { prompt, llm: template.llm, tool_ids: toolIds, built_in_tools: builtIn };
  if (template.temperature != null) llm.temperature = template.temperature;

  const voiceFor = lang => (lang === 'fa' ? p.voice_id_fa || voices.fa : p.voice_id || voices.en);
  const tts = { ...template.tts };
  if (voiceFor(template.language)) tts.voice_id = voiceFor(template.language);

  const languagePresets = {};
  for (const lang of template.additional_languages) {
    const preset = { overrides: { agent: { language: lang } } };
    if (voiceFor(lang)) preset.overrides.tts = { voice_id: voiceFor(lang) };
    languagePresets[lang] = preset;
  }

  const keywords = [p.business_name, ...(p.services || []).flatMap(s => [s.name_en, s.name_fa]), p.nearest_station].filter(Boolean).slice(0, 50);
  const platform = {
    data_collection: template.data_collection,
    evaluation: { criteria: template.evaluation_criteria.map(c => ({ type: 'prompt', ...c })) },
    privacy: template.privacy,
  };
  if (postCallWebhookId) platform.workspace_overrides = { webhooks: { post_call_webhook_id: postCallWebhookId } };

  return {
    name: `${template.name_prefix} — ${p.business_name} (${business.id})`,
    tags: ['receptionist', `business:${business.id}`, `template:v${template.template_version}`],
    conversation_config: {
      agent: { first_message: firstMessage, language: template.language, prompt: llm },
      tts,
      asr: { ...template.asr, keywords },
      turn: template.turn,
      conversation: template.conversation,
      language_presets: languagePresets,
    },
    platform_settings: platform,
  };
}

const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

/** Fields we own on the live agent that must match what we would push. Returns the names that differ. */
export function agentDrift(live, expected) {
  const fields = [
    'conversation_config.agent.prompt.prompt',
    'conversation_config.agent.first_message',
    'conversation_config.agent.prompt.llm',
    'conversation_config.agent.language',
    'conversation_config.tts.voice_id',
    'conversation_config.conversation.max_duration_seconds',
  ];
  const diff = fields.filter(f => (get(live, f) ?? null) !== (get(expected, f) ?? null));
  const ids = o => [...(get(o, 'conversation_config.agent.prompt.tool_ids') || [])].sort().join(',');
  if (ids(live) !== ids(expected)) diff.push('conversation_config.agent.prompt.tool_ids');
  const transfer = o => JSON.stringify(get(o, 'conversation_config.agent.prompt.built_in_tools.transfer_to_number.params.transfers') ?? null);
  if (transfer(live) !== transfer(expected)) diff.push('transfer_to_number');
  return diff;
}
