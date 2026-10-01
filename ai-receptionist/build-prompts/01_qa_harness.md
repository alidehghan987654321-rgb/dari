# M1 — Automated conversation QA harness

> Paste `00_master_context.md` first, then this.

## Goal

Run the 24 scenarios in `prompts/test_scenarios.md` automatically after every prompt or profile change, so prompt quality is measured, not guessed. Phase 1 gate: ≥ 90% of booking scenarios pass and zero invented facts.

## Build

1. `qa/scenarios.yaml`: convert each scenario in `prompts/test_scenarios.md` into a machine-readable case: `id`, `language` (fa/en), `caller_turns` (list of caller lines; Persian lines must use everyday spoken Persian, some mixed with English words), `expected_tools` (ordered tool names and key argument checks), `must_say` / `must_not_say` (regex, e.g. no price that is not in the profile), `end_state` (booking created? message taken? transfer?).
2. `qa/run.mjs` (Node 22): two modes.
   - **text mode (default, cheap)**: simulate the agent with the same LLM and the rendered system prompt (`scripts/build_prompt.mjs`), expose the 6 tools as function definitions that call a local `wrangler dev` Worker with a fresh D1 seeded from `business_profile.example.json`. Play the caller turns in order. Record the transcript and tool calls.
   - **platform mode**: if the ElevenLabs agent testing / simulation API is available (check current docs), run the same cases against the real agent and collect results. Keep this optional behind `--platform`.
3. A judge step: for each case, check `expected_tools`, `must_say`, `must_not_say`, `end_state` deterministically. Only if needed, add an LLM-as-judge check for "was the reply polite, short, in the caller's language" with a fixed rubric; report it separately.
4. Output `qa/report.md` + `qa/report.json`: pass/fail per case, failure reason, transcript excerpt, overall booking accuracy %, invented-fact count, average turns per booking.
5. `npm run qa` script and a GitHub Action (manual trigger) that runs text mode.

## Acceptance

- Running `npm run qa` from a clean checkout produces the report in under 10 minutes.
- At least these cases are covered: A1–A6, B1–B3, C1–C3, C5–C11, C15.
- A deliberately broken prompt (remove the "never invent prices" rule) makes at least one case fail.

## Out of scope

Audio/accent testing (done by humans in Phase 1 with the table in `test_scenarios.md`).
