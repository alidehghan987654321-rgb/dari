// --platform: run the cases against the real ElevenLabs agent with its simulate-conversation API.
// POST /v1/convai/agents/{agent_id}/simulate-conversation (shape taken from the official elevenlabs-js SDK;
// re-check the current API reference before relying on it). Experimental and optional.
//
// The real agent calls the real Worker, so only point this at a TEST agent whose business is a test business:
// bookings it makes are real rows. Cases with fixtures or tools_down are skipped (they need a controlled DB).

const API = 'https://api.elevenlabs.io';

export function platformSkipReason(caseDef) {
  if (caseDef.fixtures?.length) return 'needs seeded bookings';
  if (caseDef.tools_down) return 'needs a failing Worker';
  if (caseDef.clock) return 'needs a fixed time of day';
  return null;
}

function callerPersona(caseDef) {
  const lines = caseDef.caller_turns.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `You are a caller phoning a business. Speak ${caseDef.language === 'fa' ? 'everyday spoken Persian' : 'English'}.
Say the following lines in order, one per turn. If the receptionist asks a direct question, answer it using only
information from these lines. Do not invent other requests. After the last line, end the call politely.
${lines}`;
}

export async function simulate(caseDef, { agentId, apiKey }) {
  const r = await fetch(`${API}/v1/convai/agents/${agentId}/simulate-conversation`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      simulation_specification: {
        simulated_user_config: {
          first_message: caseDef.caller_turns[0],
          language: caseDef.language,
          prompt: { prompt: callerPersona(caseDef) },
        },
      },
      new_turns_limit: 30,
    }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return toRun(await r.json());
}

/** Map the simulation response onto the harness transcript + a database view built from tool results. */
export function toRun(sim) {
  const transcript = [];
  const db = { bookings: [], messages: [] };
  const parse = s => { try { return JSON.parse(s); } catch { return s; } };
  for (const turn of sim.simulated_conversation || []) {
    const results = Object.fromEntries((turn.tool_results || []).map(t => [t.request_id, parse(t.result_value)]));
    for (const call of turn.tool_calls || []) {
      const result = results[call.request_id] ?? null;
      transcript.push({ role: 'tool', name: call.tool_name, input: parse(call.params_as_json), result });
      if (call.tool_name === 'create_booking' && result?.ok) db.bookings.push({ id: result.booking_id, status: 'confirmed', date: result.date, time: result.time });
      if (call.tool_name === 'take_message' && result?.ok) db.messages.push({ id: db.messages.length + 1 });
    }
    if (turn.message) transcript.push({ role: turn.role === 'agent' ? 'agent' : 'caller', text: turn.message });
  }
  if (transcript[0]?.role !== 'agent') transcript.unshift({ role: 'agent', text: '' }); // judge skips the greeting slot
  return { transcript, db, fixtures: [], analysis: sim.analysis };
}
