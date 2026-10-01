// qa/report.md + qa/report.json
import { writeFileSync } from 'node:fs';

const pct = x => (x == null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);

export function writeReports(dir, { meta, summary, results, rubric }) {
  writeFileSync(`${dir}/report.json`, JSON.stringify({ meta, summary, results, rubric }, null, 2));

  const lines = [];
  lines.push('# Receptionist QA report', '');
  lines.push(`- Run: ${meta.startedAt} (${meta.mode} mode, ${meta.provider} / ${meta.model}${meta.mutate ? `, prompt mutation: **${meta.mutate}**` : ''})`);
  lines.push(`- Simulated call date: ${meta.qaToday} (${meta.timezone})`);
  lines.push(`- Duration: ${Math.round(meta.durationMs / 1000)} s`, '');
  lines.push('## Summary', '');
  lines.push('| Metric | Value |', '| --- | --- |');
  lines.push(`| Cases passed | ${summary.passed} / ${summary.cases} |`);
  lines.push(`| Booking accuracy (${summary.bookingCases} booking cases) | ${pct(summary.bookingAccuracy)} |`);
  lines.push(`| Invented facts | ${summary.inventedFacts} |`);
  lines.push(`| Average agent turns per booking | ${summary.avgTurnsPerBooking == null ? 'n/a' : summary.avgTurnsPerBooking.toFixed(1)} |`);
  lines.push(`| Phase 1 gate (≥ 90% booking accuracy, 0 invented facts) | ${summary.gate.passed ? '✅ pass' : '❌ fail'} |`, '');

  lines.push('## Cases', '');
  lines.push('| Case | Result | Tools called | Reason |', '| --- | --- | --- | --- |');
  for (const r of results) {
    const reason = r.failures.length ? r.failures[0].replace(/\|/g, '\\|').replace(/\n/g, ' ') : '';
    lines.push(`| ${r.id} ${r.title || ''} | ${r.pass ? '✅' : '❌'} | ${r.toolCalls.join(', ') || '—'} | ${reason} |`);
  }

  const failed = results.filter(r => !r.pass);
  if (failed.length) {
    lines.push('', '## Failures', '');
    for (const r of failed) {
      lines.push(`### ${r.id} ${r.title || ''}`, '');
      for (const f of r.failures) lines.push(`- ${f}`);
      lines.push('', '```', ...r.excerpt, '```', '');
    }
  }

  if (rubric?.length) {
    lines.push('', '## Style check (LLM judge, reported separately)', '');
    lines.push('| Case | Polite | Short | Caller\'s language | Notes |', '| --- | --- | --- | --- | --- |');
    const yn = v => (v === true ? '✅' : v === false ? '❌' : '?');
    for (const x of rubric) lines.push(`| ${x.id} | ${yn(x.polite)} | ${yn(x.short)} | ${yn(x.language_ok)} | ${(x.notes || '').replace(/\|/g, '/')} |`);
  }
  writeFileSync(`${dir}/report.md`, lines.join('\n') + '\n');
}
