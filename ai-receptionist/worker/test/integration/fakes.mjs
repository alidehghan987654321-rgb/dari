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

/** Minimal Stripe: prices/products, Checkout, Portal, Subscriptions (state set by the test), invoice items. */
export function fakeStripe(mock) {
  const st = { prices: [], subs: new Map(), checkouts: [], invoiceItems: [], n: 0 };
  mock.routes.push(({ method: m, url: u, body }) => {
    if (u.startsWith('/v1/prices') && m === 'GET') {
      const key = new URLSearchParams(u.split('?')[1]).get('lookup_keys[0]');
      return { body: { data: st.prices.filter(p => p.lookup_key === key) } };
    }
    if (u === '/v1/products' && m === 'POST') return { body: { id: `prod_${++st.n}` } };
    if (u === '/v1/prices' && m === 'POST') {
      const p = { id: `price_${body['metadata[plan_id]'] || ++st.n}`, lookup_key: body.lookup_key, unit_amount: Number(body.unit_amount), currency: body.currency };
      st.prices.push(p);
      return { body: p };
    }
    if (u === '/v1/checkout/sessions' && m === 'POST') { st.checkouts.push(body); return { body: { id: `cs_${++st.n}`, url: `https://checkout.stripe.test/cs_${st.n}` } }; }
    if (u === '/v1/billing_portal/sessions' && m === 'POST') return { body: { url: `https://billing.stripe.test/${body.customer}` } };
    const sub = /^\/v1\/subscriptions\/(\w+)$/.exec(u);
    if (sub && m === 'GET') return st.subs.has(sub[1]) ? { body: st.subs.get(sub[1]) } : { status: 404, body: { error: { message: 'No such subscription' } } };
    if (u === '/v1/invoiceitems' && m === 'POST') { st.invoiceItems.push(body); return { body: { id: `ii_${++st.n}` } }; }
    return undefined;
  });
  return st;
}
