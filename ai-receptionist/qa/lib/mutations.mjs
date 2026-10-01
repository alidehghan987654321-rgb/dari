// Deliberate prompt breakages, to prove the QA cases catch regressions (`--mutate <name>`).

export const MUTATIONS = {
  // Removes the "never invent" guardrails: the agent may now guess prices and facts.
  'no-invent-guard': [
    'If a question is not answered by these facts, do not guess. Say you are not sure and offer to take a message for the team.',
    '- Never make up prices, offers, discounts, opening hours or policies.',
  ],
  // Removes the confirm-before-booking step.
  'no-confirm': [
    '   e. Confirm everything back in one sentence: service, weekday, date, time, name. Wait for a clear yes.',
  ],
};

export function mutate(template, name) {
  if (!name) return template;
  const lines = MUTATIONS[name];
  if (!lines) throw new Error(`Unknown mutation "${name}". Known: ${Object.keys(MUTATIONS).join(', ')}`);
  let out = template;
  for (const line of lines) {
    if (!out.includes(line)) throw new Error(`Mutation "${name}" no longer matches the template: ${line}`);
    out = out.replace(line + '\n', '').replace(line, '');
  }
  return out;
}
