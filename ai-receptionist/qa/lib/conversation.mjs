// Plays one scripted call: greeting, then each caller line, letting the agent call tools between lines.
// Returns a transcript of { role: 'agent' | 'caller', text } and { role: 'tool', name, input, result } entries.

const MAX_TOOL_ROUNDS = 6; // per caller turn; a real agent that loops longer than this is broken anyway

export async function playCall({ session, greeting, callerTurns, execute }) {
  const transcript = [{ role: 'agent', text: greeting }];
  let ended = false;

  for (const line of callerTurns) {
    if (ended) break;
    transcript.push({ role: 'caller', text: line });
    session.caller(line);

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const { text, toolCalls } = await session.step();
      if (text) transcript.push({ role: 'agent', text });
      if (!toolCalls.length) break;
      if (round === MAX_TOOL_ROUNDS) {
        transcript.push({ role: 'agent', text: '[harness: too many tool calls in one turn]' });
        break;
      }
      const results = [];
      for (const c of toolCalls) {
        const { result, ends } = await execute(c.name, c.input);
        transcript.push({ role: 'tool', name: c.name, input: c.input, result });
        results.push({ id: c.id, result });
        if (ends) ended = true;
      }
      session.toolResults(results);
      if (ended) break;
    }
  }
  return { transcript, ended };
}
