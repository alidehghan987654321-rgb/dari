// Stateful fakes of external platforms for integration tests (plug into dev.mock.routes).

/** Minimal in-memory ElevenLabs + Twilio, enough to check what the Worker sends and that it is idempotent. */
export function fakePlatform(mock) {
  const st = { agents: new Map(), tools: new Map(), numbers: new Map(), secrets: 0, n: 0 };
  mock.routes.push(({ method: m, url: u, body }) => {
    if (u === '/v1/convai/secrets' && m === 'POST') { st.secrets++; return { body: { secret_id: `sec_${st.secrets}`, name: body.name } }; }
    if (u === '/v1/convai/tools' && m === 'POST') { const id = `tool_${++st.n}`; st.tools.set(id, body); return { body: { id } }; }
    let x = /^\/v1\/convai\/tools\/(\w+)$/.exec(u);
    if (x) {
      if (!st.tools.has(x[1])) return { status: 404, body: { detail: 'not found' } };
      if (m === 'PATCH') st.tools.set(x[1], body);
      if (m === 'DELETE') st.tools.delete(x[1]);
      return { body: { id: x[1] } };
    }
    if (u === '/v1/convai/agents/create' && m === 'POST') { const id = `agent_${++st.n}`; st.agents.set(id, structuredClone(body)); return { body: { agent_id: id } }; }
    x = /^\/v1\/convai\/agents\/(\w+)$/.exec(u);
    if (x) {
      const a = st.agents.get(x[1]);
      if (!a) return { status: 404, body: { detail: 'not found' } };
      if (m === 'GET') return { body: { agent_id: x[1], ...a } };
      if (m === 'PATCH') { st.agents.set(x[1], structuredClone(body)); return { body: { agent_id: x[1] } }; }
      if (m === 'DELETE') { st.agents.delete(x[1]); return { body: {} }; }
    }
    if (u === '/v1/convai/phone-numbers' && m === 'POST') { const id = `pn_${++st.n}`; st.numbers.set(id, { ...body }); return { body: { phone_number_id: id } }; }
    x = /^\/v1\/convai\/phone-numbers\/(\w+)$/.exec(u);
    if (x) {
      if (m === 'PATCH') Object.assign(st.numbers.get(x[1]), body);
      if (m === 'DELETE') st.numbers.delete(x[1]);
      return { body: { phone_number_id: x[1] } };
    }
    if (u.includes('/AvailablePhoneNumbers/GB/Local.json')) return { body: { available_phone_numbers: [{ phone_number: '+442071234567' }] } };
    if (u.endsWith('/IncomingPhoneNumbers.json') && m === 'POST') return { body: { sid: 'PN1', phone_number: body.PhoneNumber } };
    return undefined;
  });
  return st;
}
