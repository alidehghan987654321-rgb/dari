#!/usr/bin/env node
// Renders the final system prompt for one business.
// Usage: node scripts/build_prompt.mjs prompts/business_profile.example.json > out/pars-barbers.prompt.md
// Leaves ElevenLabs system variables ({{system__...}}) untouched so the platform fills them at call time.

import { readFileSync } from 'node:fs';
import { loadTemplate, render } from './prompt.mjs';

const profilePath = process.argv[2];
if (!profilePath) {
  console.error('Usage: node scripts/build_prompt.mjs <business_profile.json>');
  process.exit(1);
}

const p = JSON.parse(readFileSync(profilePath, 'utf8'));
process.stdout.write(render(loadTemplate(), p));
