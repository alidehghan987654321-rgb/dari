// Node wrapper around shared/prompt-core.mjs that reads the templates from prompts/.
// Used by the build_prompt.mjs CLI and the QA harness; the Worker imports the core directly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { firstMessageFrom } from '../shared/prompt-core.mjs';

export { render, renderProfile, servicePrice, promptHash, firstMessageFrom } from '../shared/prompt-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadTemplate() {
  return readFileSync(join(ROOT, 'prompts', 'system_prompt.template.md'), 'utf8');
}

export function renderFirstMessage(p) {
  return firstMessageFrom(readFileSync(join(ROOT, 'prompts', 'first_message.md'), 'utf8'), p);
}
