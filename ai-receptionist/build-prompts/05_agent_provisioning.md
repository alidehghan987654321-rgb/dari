# M5 — Automatic agent provisioning

> Paste `00_master_context.md` first, then this.

## Goal

Setting up a new business goes from ~2 hours of dashboard clicking to one command (and later one button in the panel), and profile changes reach the live agent automatically.

## Build

1. `provisioning/` module in the Worker (or a Node CLI that the Worker can also call) with these operations, each idempotent:
   - `createAgent(business)`: create an ElevenLabs agent from our template: rendered system prompt (`build_prompt.mjs` logic moved into a shared module), first message, languages (en + fa), voice ids, LLM, temperature, turn timeout, the 6 webhook tools pointing at `/b/{business_id}/...` with the `Authorization` secret, system tools (end_call, language_detection, transfer_to_number with the business transfer number, skip_turn), data-collection fields, post-call webhook, retention.
   - `syncAgent(business)`: re-render the prompt and update the agent when `profile_json` changed (triggered by the panel save from M3).
   - `attachNumber(business)`: import or assign a Twilio number to the agent (or buy a new UK local number via Twilio API if `buy: true`; UK numbers need an approved regulatory bundle — surface a clear error if missing).
   - `pauseAgent / resumeAgent`: for message-only mode and cancellations (M4).
   - `deleteAgent`: on cancellation after the retention period.
2. **Read the current ElevenLabs Agents API and Twilio API docs first**; map our template to the exact current request schema. Store our template as `config/agent_template.json` (versioned). Record `template_version` and `agent_id` per business.
3. CLI: `node provisioning/cli.mjs create --profile prompts/my-business.json` prints the agent id and the next manual steps (if any).
4. Drift check: a daily cron compares the live agent config with what we would render and reports differences to the team chat.

## Acceptance

- Creating a test business end to end produces a working agent that answers a test call (manual check) without touching the ElevenLabs dashboard.
- Changing opening hours in the panel updates the agent prompt within 1 minute.
- Running `create` twice does not create two agents.
