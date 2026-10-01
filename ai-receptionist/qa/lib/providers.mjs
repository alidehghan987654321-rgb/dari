// LLM providers for text-mode QA. Each provider opens a "session" that owns the message history in its own
// wire format and exposes the same small interface:
//   session.caller(text)          the caller says something
//   await session.step()          -> { text, toolCalls: [{ id, name, input }] }
//   session.toolResults([{ id, result }])
// Use the same model the live agent uses (config/agent_settings.md) so QA measures what callers get.

import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const CONNECTED = '[The phone call has just connected.]';

/**
 * Anthropic Messages API through the official SDK. Reads ANTHROPIC_API_KEY.
 * No temperature: current Claude models reject non-default sampling values. Effort defaults to "low",
 * which suits short phone turns; raise it with QA_EFFORT to compare.
 * Server-side refusal fallback ("default") is on, so a rare policy decline is re-run on Anthropic's
 * recommended fallback model instead of failing the case.
 */
export function anthropicProvider({ model = agentLlm(), effort = 'low' } = {}) {
  const client = new Anthropic();
  const request = params => client.beta.messages.create({
    model, max_tokens: 4096, output_config: { effort },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    ...params,
  });

  return {
    name: 'anthropic', model,
    session(system, tools, greeting) {
      const toolDefs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      const messages = [{ role: 'user', content: CONNECTED }, { role: 'assistant', content: greeting }];
      return {
        caller(text) { messages.push({ role: 'user', content: text }); },
        async step() {
          const r = await request({ system, tools: toolDefs, messages });
          if (r.stop_reason === 'refusal') throw new Error(`model refused (${r.stop_details?.category ?? 'no category'})`);
          const content = echoable(r.content);
          if (content.length) messages.push({ role: 'assistant', content });
          return {
            text: content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim(),
            toolCalls: content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })),
          };
        },
        toolResults(results) {
          messages.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result) })) });
        },
      };
    },
    async complete(prompt) {
      const r = await request({ messages: [{ role: 'user', content: prompt }] });
      return r.content.filter(b => b.type === 'text').map(b => b.text).join('');
    },
  };
}

// After a server-side fallback, blocks the declined model produced before the switch point are not echoed
// back (only its text is); the fallback marker itself is dropped. Without a fallback, content is unchanged.
function echoable(content) {
  const last = content.map(b => b.type).lastIndexOf('fallback');
  if (last < 0) return content;
  return content.filter((b, i) => b.type !== 'fallback' && (i > last || b.type === 'text'));
}

/**
 * Any OpenAI-compatible chat completions API (OpenAI, Gemini's compatible endpoint, a local server).
 * Reads OPENAI_API_KEY and OPENAI_BASE_URL. Temperature 0.3 matches the agent settings.
 */
export function openaiProvider({ model = 'gpt-4.1', baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' } = {}) {
  async function chat(body) {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.3, ...body }),
    });
    if (!r.ok) throw new Error(`LLM API ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).choices[0].message;
  }
  return {
    name: 'openai', model,
    session(system, tools, greeting) {
      const toolDefs = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const messages = [{ role: 'system', content: system }, { role: 'user', content: CONNECTED }, { role: 'assistant', content: greeting }];
      return {
        caller(text) { messages.push({ role: 'user', content: text }); },
        async step() {
          const msg = await chat({ messages, tools: toolDefs });
          messages.push(msg);
          return {
            text: (msg.content || '').trim(),
            toolCalls: (msg.tool_calls || []).map(c => ({ id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || '{}') })),
          };
        },
        toolResults(results) {
          for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) });
        },
      };
    },
    async complete(prompt) {
      return (await chat({ messages: [{ role: 'user', content: prompt }] })).content || '';
    },
  };
}

/**
 * Scripted provider for testing the harness itself (no network). `script(state)` returns the next
 * { text, toolCalls } given { caseId, callerTurns, lastResults, step }.
 */
export function fakeProvider(script) {
  return {
    name: 'fake', model: 'scripted',
    session(system, tools, greeting, caseId) {
      const state = { caseId, system, callerTurns: [], lastResults: [], step: 0 };
      let n = 0;
      return {
        caller(text) { state.callerTurns.push(text); state.lastResults = []; },
        async step() {
          state.step++;
          const out = script(state) || {};
          return { text: out.text || '', toolCalls: (out.toolCalls || []).map(c => ({ id: `call_${++n}`, ...c })) };
        },
        toolResults(results) { state.lastResults = results; },
      };
    },
    async complete() { return '{"polite": true, "short": true, "language_ok": true, "notes": "fake"}'; },
  };
}

/** The LLM the live agent runs on (config/agent_template.json), so QA measures what callers get. */
export function agentLlm() {
  return JSON.parse(readFileSync(new URL('../../config/agent_template.json', import.meta.url), 'utf8')).llm;
}

export function providerFromEnv(env = process.env) {
  const kind = env.QA_PROVIDER || 'anthropic';
  if (kind === 'anthropic') return anthropicProvider({ model: env.QA_MODEL || agentLlm(), effort: env.QA_EFFORT || undefined });
  if (kind === 'openai') return openaiProvider({ model: env.QA_MODEL || undefined });
  throw new Error(`Unknown QA_PROVIDER "${kind}" (use anthropic or openai)`);
}
