#!/usr/bin/env node
// Renders the final system prompt for one business.
// Usage: node scripts/build_prompt.mjs prompts/business_profile.example.json > out/pars-barbers.prompt.md
// Leaves ElevenLabs system variables ({{system__...}}) untouched so the platform fills them at call time.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const profilePath = process.argv[2];
if (!profilePath) {
  console.error('Usage: node scripts/build_prompt.mjs <business_profile.json>');
  process.exit(1);
}

const p = JSON.parse(readFileSync(profilePath, 'utf8'));
const template = readFileSync(join(here, '..', 'prompts', 'system_prompt.template.md'), 'utf8');

const DAYS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

export function renderProfile(p) {
  const lines = [];
  lines.push(`- Name: ${p.business_name} (${p.business_type})`);
  lines.push(`- Address: ${p.address}`);
  if (p.nearest_station) lines.push(`- Nearest station: ${p.nearest_station}`);
  if (p.parking) lines.push(`- Parking: ${p.parking}`);
  lines.push('- Opening hours (UK time):');
  for (const [k, label] of Object.entries(DAYS)) {
    const ranges = p.opening_hours?.[k] || [];
    lines.push(`  - ${label}: ${ranges.length ? ranges.map(r => `${r[0]} to ${r[1]}`).join(', ') : 'closed'}`);
  }
  if (p.closed_dates?.length) lines.push(`- Also closed on: ${p.closed_dates.join(', ')}`);
  lines.push('- Services (use the id with tools):');
  for (const s of p.services || []) {
    lines.push(`  - id "${s.id}": ${s.name_en} / ${s.name_fa}, ${s.duration_min} minutes, £${s.price_gbp}`);
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
  return lines.join('\n');
}

export function render(template, p) {
  const vars = {
    assistant_name: p.assistant_name || 'the assistant',
    business_name: p.business_name,
    business_type: p.business_type,
    city: p.city,
    transfer_hours: p.transfer_hours || 'business opening hours',
    business_profile: renderProfile(p),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? vars[key] : m));
}

process.stdout.write(render(template, p));
