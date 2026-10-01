#!/usr/bin/env node
// M5 — provisioning from the command line. Talks to the Worker's admin API, so every secret (ElevenLabs,
// Twilio) stays in the Worker and the CLI, the panel and the crons run the same code.
//
//   export WORKER_URL=https://ai-receptionist.<you>.workers.dev ADMIN_SECRET=...
//   node provisioning/cli.mjs setup
//   node provisioning/cli.mjs create --profile prompts/my-business.json [--number +44... | --buy]
//   node provisioning/cli.mjs sync <business_id> [--force]
//   node provisioning/cli.mjs attach <business_id> (--number +44... | --buy)
//   node provisioning/cli.mjs pause|resume|delete <business_id>

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { profile: { type: 'string' }, number: { type: 'string' }, buy: { type: 'boolean' }, force: { type: 'boolean' } },
});
const [command, id] = positionals;
const { WORKER_URL, ADMIN_SECRET } = process.env;

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node provisioning/cli.mjs setup | create --profile <file> [--number +44.. | --buy] | sync <id> [--force] | attach <id> (--number +44.. | --buy) | pause|resume|delete <id>');
  process.exit(2);
}

async function admin(method, path, body) {
  const r = await fetch(`${WORKER_URL.replace(/\/$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_SECRET}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) {
    console.error(`✗ ${data.error || r.status}: ${data.message || JSON.stringify(data)}`);
    process.exit(1);
  }
  return data;
}

const attachBody = () => (values.buy ? { action: 'attach-number', buy: true } : values.number ? { action: 'attach-number', phone_number: values.number } : null);

if (!WORKER_URL || !ADMIN_SECRET) usage('Set WORKER_URL and ADMIN_SECRET.');

switch (command) {
  case 'setup': {
    const r = await admin('POST', '/admin/provisioning/setup');
    console.log(`✓ ElevenLabs workspace secret ready (${r.secret_id}).`);
    break;
  }
  case 'create': {
    if (!values.profile) usage('create needs --profile <file>.');
    const profile = JSON.parse(readFileSync(values.profile, 'utf8'));
    await admin('PUT', '/admin/businesses', { profile });
    const r = await admin('POST', `/admin/b/${profile.business_id}/provision`, { action: 'create' });
    console.log(`✓ ${r.created ? 'Created' : 'Already existed, synced'}: agent ${r.agent_id} for ${profile.business_id}`);
    const attach = attachBody();
    if (attach) {
      const n = await admin('POST', `/admin/b/${profile.business_id}/provision`, attach);
      console.log(`✓ Number ${n.phone_number}${n.bought ? ' (bought)' : ''} answers with this agent.`);
    }
    const steps = (r.next_steps || []).filter(s => !(attach && s.startsWith('Attach')));
    if (steps.length) console.log(`\nNext steps:\n${steps.map(s => `  • ${s}`).join('\n')}`);
    console.log('  • The owner forwards their line (busy / no answer) to the number. Then make a test call.');
    break;
  }
  case 'sync': {
    if (!id) usage();
    const r = await admin('POST', `/admin/b/${id}/provision`, { action: 'sync', force: !!values.force });
    console.log(r.synced ? `✓ ${id} synced.` : `✓ ${id} already up to date.`);
    break;
  }
  case 'attach': {
    const body = attachBody();
    if (!id || !body) usage('attach needs <id> and --number or --buy.');
    const r = await admin('POST', `/admin/b/${id}/provision`, body);
    console.log(`✓ ${r.phone_number}${r.bought ? ' (bought)' : ''} -> ${id}`);
    break;
  }
  case 'pause':
  case 'resume':
  case 'delete': {
    if (!id) usage();
    const r = await admin('POST', `/admin/b/${id}/provision`, { action: command });
    console.log(`✓ ${command} ${id}${r.kept_twilio_number ? ` (Twilio number ${r.kept_twilio_number} kept; release it in Twilio if not needed)` : ''}`);
    break;
  }
  default:
    usage();
}
