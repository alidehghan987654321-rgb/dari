#!/usr/bin/env node
// M1 — automated conversation QA. Plays the scenarios in scenarios.yaml against the receptionist prompt and
// writes report.md + report.json. See qa/README.md.
//
//   npm run qa                                   text mode, all cases
//   npm run qa -- --cases A1,C3                  some cases
//   npm run qa -- --mutate no-invent-guard       prove a broken prompt is caught
//   npm run qa -- --llm-judge                    also score politeness/brevity/language (reported separately)
//   npm run qa -- --platform                     against the real ElevenLabs agent (QA_AGENT_ID, ELEVENLABS_API_KEY)

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { loadTemplate, render, renderFirstMessage } from '../scripts/prompt.mjs';
import { startDev, seedBusiness } from '../worker/test/integration/dev.mjs';
import { qaToday, qaNow, resolveDate } from './lib/clock.mjs';
import { loadTools, makeExecutor } from './lib/tools.mjs';
import { playCall } from './lib/conversation.mjs';
import { judgeCase, summarise } from './lib/judge.mjs';
import { providerFromEnv } from './lib/providers.mjs';
import { mutate } from './lib/mutations.mjs';
import { writeReports } from './lib/report.mjs';
import { simulate, platformSkipReason } from './lib/platform.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DEFAULT_CALLER = '+447700900123'; // Ofcom drama range: never a real person

export function loadScenarios(file = join(HERE, 'scenarios.yaml')) {
  return YAML.parse(readFileSync(file, 'utf8')).cases;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Runs one case in text mode against a running dev Worker. */
async function runTextCase(caseDef, { dev, provider, template, baseProfile, today, tools }) {
  const businessId = `qa-${caseDef.id.toLowerCase()}`;
  const profile = await seedBusiness(dev, { ...baseProfile, ...caseDef.profile, business_id: businessId });
  const tz = profile.timezone || 'Europe/London';

  const fixtures = [];
  for (const f of caseDef.fixtures || []) {
    const date = resolveDate(f.date, today);
    const r = await dev.tool(businessId, 'book', { language: 'fa', ...f, date });
    if (!r.ok) throw new Error(`fixture booking failed: ${JSON.stringify(r)}`);
    fixtures.push({ id: r.booking_id, date, time: r.time });
  }

  const system = render(template, profile, {
    system__time_utc: qaNow(today, tz, caseDef.clock).toISOString(),
    system__caller_id: caseDef.caller_id ?? DEFAULT_CALLER,
  });
  const greeting = renderFirstMessage(profile);
  const session = provider.session(system, tools, greeting, caseDef.id);
  const execute = makeExecutor({ tools, call: dev.tool, businessId, toolsDown: !!caseDef.tools_down });
  const { transcript } = await playCall({ session, greeting, callerTurns: caseDef.caller_turns, execute });

  const bookings = (await dev.admin('GET', `/admin/b/${businessId}/bookings`)).data.bookings || [];
  const messages = (await dev.admin('GET', `/admin/b/${businessId}/messages`)).data.messages || [];
  return { transcript, db: { bookings, messages }, fixtures };
}

const RUBRIC = `You review one phone call handled by an AI receptionist. Answer ONLY with JSON:
{"polite": true|false, "short": true|false, "language_ok": true|false, "notes": "<one short sentence>"}
- polite: warm and respectful in every agent turn.
- short: agent turns are one or two sentences, one question at a time, no lists.
- language_ok: the agent answers in the language the caller is using (Persian with some English words counts as Persian).`;

async function styleCheck(provider, result, transcript) {
  const call = transcript.filter(e => e.role !== 'tool').map(e => `${e.role}: ${e.text}`).join('\n');
  const text = await provider.complete(`${RUBRIC}\n\nCall:\n${call}`);
  try { return { id: result.id, ...JSON.parse(/\{[\s\S]*\}/.exec(text)[0]) }; } catch { return { id: result.id, notes: 'judge reply was not JSON' }; }
}

/**
 * Programmatic entry (used by tests). Returns { summary, results, meta }.
 * opts: { cases, provider, concurrency, mutate, llmJudge, platform, outDir, scenarios }
 */
export async function runQa(opts = {}) {
  const startedAt = new Date();
  const all = opts.scenarios || loadScenarios();
  const wanted = opts.cases?.length ? all.filter(c => opts.cases.includes(c.id)) : all.filter(c => !c.human_only);
  if (!wanted.length) throw new Error('No matching cases.');

  const baseProfile = JSON.parse(readFileSync(join(ROOT, 'prompts', 'business_profile.example.json'), 'utf8'));
  const tz = baseProfile.timezone || 'Europe/London';
  const today = qaToday(new Date(), tz);
  const allowedPrices = baseProfile.services.map(s => s.price ?? s.price_gbp);
  const template = mutate(loadTemplate(), opts.mutate);
  const tools = loadTools();
  const provider = opts.platform ? null : (opts.provider || providerFromEnv());

  const runs = [];
  const results = [];
  if (opts.platform) {
    const agentId = process.env.QA_AGENT_ID;
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!agentId || !apiKey) throw new Error('--platform needs QA_AGENT_ID and ELEVENLABS_API_KEY.');
    await pool(wanted, opts.concurrency || 2, async c => {
      const skip = platformSkipReason(c);
      if (skip) { console.log(`skip ${c.id}: ${skip}`); return; }
      try {
        const run = await simulate(c, { agentId, apiKey });
        runs.push({ c, run });
      } catch (e) {
        results.push(harnessFailure(c, e));
      }
    });
  } else {
    const dev = await startDev();
    try {
      await pool(wanted, opts.concurrency || 4, async c => {
        try {
          const run = await runTextCase(c, { dev, provider, template, baseProfile, today, tools });
          runs.push({ c, run });
          process.stdout.write('.');
        } catch (e) {
          results.push(harnessFailure(c, e));
          process.stdout.write('E');
        }
      });
      process.stdout.write('\n');
    } finally {
      await dev.stop();
    }
  }

  for (const { c, run } of runs) {
    const r = judgeCase(c, run, { today, allowedPrices });
    r.transcript = run.transcript;
    results.push(r);
  }
  const order = new Map(all.map((c, i) => [c.id, i]));
  results.sort((a, b) => order.get(a.id) - order.get(b.id));

  let rubric = null;
  if (opts.llmJudge && provider) {
    rubric = await pool(results.filter(r => r.transcript), 4, r => styleCheck(provider, r, r.transcript));
  }

  const summary = summarise(results);
  const meta = {
    startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt, mode: opts.platform ? 'platform' : 'text',
    provider: provider?.name || 'elevenlabs', model: provider?.model || process.env.QA_AGENT_ID, mutate: opts.mutate || null,
    qaToday: today, timezone: tz,
  };
  const forReport = results.map(({ transcript, ...r }) => r);
  if (opts.outDir !== null) writeReports(opts.outDir || HERE, { meta, summary, results: forReport, rubric });
  return { meta, summary, results, rubric };
}

function harnessFailure(c, e) {
  return {
    id: c.id, title: c.title, tags: c.tags || [], pass: false, failures: [`harness error: ${e.message}`],
    invented: [], agentTurns: 0, bookingCreated: false, toolCalls: [], excerpt: [],
  };
}

// ---------- CLI ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      cases: { type: 'string' },
      concurrency: { type: 'string' },
      mutate: { type: 'string' },
      'llm-judge': { type: 'boolean' },
      platform: { type: 'boolean' },
      out: { type: 'string' },
    },
  });
  try {
    const { summary, results } = await runQa({
      cases: values.cases?.split(',').map(s => s.trim()),
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
      mutate: values.mutate,
      llmJudge: values['llm-judge'],
      platform: values.platform,
      outDir: values.out,
    });
    for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}${r.pass ? '' : `  ${r.failures[0]}`}`);
    const pct = summary.bookingAccuracy == null ? 'n/a' : `${Math.round(summary.bookingAccuracy * 100)}%`;
    console.log(`\n${summary.passed}/${summary.cases} passed · booking accuracy ${pct} · invented facts ${summary.inventedFacts}`);
    console.log(`Phase 1 gate: ${summary.gate.passed ? 'PASS' : 'FAIL'} — report: ${values.out || 'qa'}/report.md`);
    process.exit(summary.passed === summary.cases ? 0 : 1);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
