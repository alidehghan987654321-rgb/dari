// Tool definitions for the simulated agent, built from config/tools.json so the harness always offers
// the model exactly the tools the real ElevenLabs agent has. Plus the platform's system tools.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SYSTEM_TOOLS = [
  {
    name: 'end_call', system: true,
    description: 'Hang up after saying goodbye.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Why the call is ending.' } }, required: [] },
  },
  {
    name: 'transfer_to_number', system: true,
    description: 'Transfer the call to the business owner. Only under the escalation rules and inside transfer hours.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Why the caller needs a person.' } }, required: ['reason'] },
  },
  {
    name: 'language_detection', system: true,
    description: 'Switch the conversation language.',
    parameters: { type: 'object', properties: { language: { type: 'string', enum: ['fa', 'en'], description: 'fa = Persian, en = English.' } }, required: ['language'] },
  },
  {
    name: 'skip_turn', system: true,
    description: 'Stay silent this turn so the caller can think.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

/** [{ name, description, parameters (JSON schema), path?, system? }] */
export function loadTools() {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'tools.json'), 'utf8'));
  const webhook = cfg.tools.map(t => {
    const properties = {};
    const required = [];
    for (const [k, v] of Object.entries(t.body)) {
      properties[k] = { type: v.type, description: v.description };
      if (v.required) required.push(k);
    }
    return { name: t.name, description: t.description, parameters: { type: 'object', properties, required }, path: t.url.split('/').pop() };
  });
  return [...webhook, ...SYSTEM_TOOLS];
}

export const BOOKING_TOOLS = new Set(['check_availability', 'create_booking', 'find_bookings', 'reschedule_booking', 'cancel_booking']);

/**
 * Executes tool calls the way the platform would. Webhook tools go to the Worker; system tools are
 * simulated. `toolsDown` makes the booking tools fail like a dead Worker (scenario C9).
 */
export function makeExecutor({ tools, call, businessId, toolsDown = false }) {
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  return async function execute(name, input) {
    const def = byName[name];
    if (!def) return { result: { ok: false, error: 'unknown_tool' }, ends: false };
    if (def.system) {
      if (name === 'end_call') return { result: { ok: true }, ends: true };
      if (name === 'transfer_to_number') return { result: { ok: true, transferred: true }, ends: true };
      return { result: { ok: true }, ends: false };
    }
    if (toolsDown && BOOKING_TOOLS.has(name)) {
      return { result: { ok: false, error: 'server_error', message_for_agent: 'The booking system had a problem. Apologise, do not confirm anything, and take a message.' }, ends: false };
    }
    return { result: await call(businessId, def.path, input || {}), ends: false };
  };
}
