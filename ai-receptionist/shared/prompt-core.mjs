// Prompt rendering without any file access, so the Cloudflare Worker (M5 provisioning) and Node
// (build_prompt.mjs, QA) share one implementation. Callers pass in the template text.

const DAYS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const CURRENCY_SYMBOL = { GBP: '£', EUR: '€', USD: '$', CAD: 'CA$' };

/** Price as the agent should read it, in the profile's currency. Accepts `price` or the older `price_gbp`. */
export function servicePrice(p, s) {
  const amount = s.price ?? s.price_gbp;
  const cur = p.currency || 'GBP';
  return `${CURRENCY_SYMBOL[cur] ?? `${cur} `}${amount}`;
}

export function renderProfile(p) {
  const lines = [];
  lines.push(`- Name: ${p.business_name} (${p.business_type})`);
  lines.push(`- Address: ${p.address}`);
  if (p.nearest_station) lines.push(`- Nearest station: ${p.nearest_station}`);
  if (p.parking) lines.push(`- Parking: ${p.parking}`);
  lines.push(`- Opening hours (local time, ${p.timezone || 'Europe/London'}):`);
  for (const [k, label] of Object.entries(DAYS)) {
    const ranges = p.opening_hours?.[k] || [];
    lines.push(`  - ${label}: ${ranges.length ? ranges.map(r => `${r[0]} to ${r[1]}`).join(', ') : 'closed'}`);
  }
  if (p.closed_dates?.length) lines.push(`- Also closed on: ${p.closed_dates.join(', ')}`);
  lines.push('- Services (use the id with tools):');
  for (const s of p.services || []) {
    lines.push(`  - id "${s.id}": ${s.name_en} / ${s.name_fa}, ${s.duration_min} minutes, ${servicePrice(p, s)}`);
  }
  if (p.policies?.length) {
    lines.push('- Policies:');
    for (const x of p.policies) lines.push(`  - ${x}`);
  }
  if (p.faq?.length) {
    lines.push('- Frequent questions:');
    for (const f of p.faq) lines.push(`  - Q: ${f.q} A: ${f.a}`);
  }
  lines.push(`- Bookings can be made from ${Math.round((p.min_notice_minutes || 0) / 60)} hour(s) ahead up to ${p.max_days_ahead || 30} days ahead.`);
  if (p.message_only) {
    lines.push('- IMPORTANT: bookings by phone are paused right now. Do not check availability or book, change or cancel anything.');
    lines.push('  Answer questions from these facts, and for anything else take a message with `take_message`.');
  }
  return lines.join('\n');
}

/**
 * Fill the template. `system` optionally fills ElevenLabs system variables (the QA harness does this to
 * simulate a call); otherwise they stay as {{system__...}} for the platform to fill at call time.
 */
export function render(template, p, system = {}) {
  const vars = {
    assistant_name: p.assistant_name || 'the assistant',
    business_name: p.business_name,
    business_type: p.business_type,
    city: p.city,
    transfer_hours: p.transfer_hours || 'business opening hours',
    business_profile: renderProfile(p),
    ...system,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? vars[key] : m));
}

/** The default bilingual first message: the first code block of prompts/first_message.md, filled in. */
export function firstMessageFrom(markdown, p) {
  const block = /```\n([\s\S]*?)```/.exec(markdown)[1].trim();
  return block.replace(/\{\{business_name\}\}/g, p.business_name);
}

/** Short stable hash of a rendered prompt (FNV-1a), to detect drift and skip no-op syncs. */
export function promptHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
