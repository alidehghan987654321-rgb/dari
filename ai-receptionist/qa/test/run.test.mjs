// End to end: the real runner, the real Worker (wrangler dev + local D1) and the real judge, with a scripted
// agent in place of the LLM. Proves the harness wiring; prompt quality itself needs a real model (npm run qa).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQa } from '../run.mjs';
import { fakeProvider } from '../lib/providers.mjs';
import { qaToday, resolveDate } from '../lib/clock.mjs';

const today = qaToday();
const sat = resolveDate('$next(sat)', today);
const call = (name, input) => ({ toolCalls: [{ name, input }] });
const bye = { text: 'ممنون، خداحافظ', toolCalls: [{ name: 'end_call', input: {} }] };

const SCRIPTS = {
  A2(s) {
    const n = s.callerTurns.length, done = s.lastResults.length > 0;
    if (n === 1) return done ? { text: 'I have ten, quarter past ten or half past ten. Which suits you?' }
      : call('check_availability', { service_id: 'mens-cut', date: sat, preferred_time: '10:00' });
    if (n === 2) return { text: 'Lovely, ten o\'clock. Could I take your name?' };
    if (n === 3) return { text: 'Thanks James. Shall I use the number you are calling from?' };
    if (n === 4) return { text: 'So that is a men\'s haircut on Saturday at ten for James Carter. Is that right?' };
    if (n === 5) return done ? { text: 'You are booked and a text is on its way. Anything else?' }
      : call('create_booking', { service_id: 'mens-cut', date: sat, time: '10:00', customer_name: 'James Carter', customer_phone: '+447700900123', language: 'en' });
    return { text: 'Thanks for calling, bye!', toolCalls: [{ name: 'end_call', input: {} }] };
  },
  A5(s) {
    return s.callerTurns.length === 1 ? { text: 'اصلاح موی بچه چهارده پوند هست.' } : bye;
  },
  B1(s) {
    const n = s.callerTurns.length;
    if (n === 1) return { text: 'حتماً. با چه شماره‌ای نوبت گرفتید؟' };
    if (n === 2) {
      if (!s.lastResults.length) return call('find_bookings', { customer_phone: '۰۷۷۰۰۹۰۰۳۲۱' });
      s.found = s.lastResults[0].result.bookings[0].booking_id;
      return { text: 'یه نوبت اصلاح برای پنجشنبه ساعت دوازده پیدا کردم. همینه؟' };
    }
    if (n === 3) return s.lastResults.length ? { text: 'نوبتتون لغو شد. امر دیگه‌ای هست؟' }
      : call('cancel_booking', { booking_id: s.found, customer_phone: '07700900321' });
    return bye;
  },
  C9(s) {
    const n = s.callerTurns.length;
    if (n === 1) return s.lastResults.length ? { text: 'متأسفم، سیستم نوبت‌دهی الان مشکل داره. اسم و شماره‌تون رو بدید تا پیام بذارم.' }
      : call('check_availability', { service_id: 'mens-cut', date: resolveDate('$tomorrow', today), preferred_time: '16:00' });
    if (n === 2) return s.lastResults.length ? { text: 'پیامتون رو رسوندم، همکارام باهاتون تماس می‌گیرن.' }
      : call('take_message', { caller_name: 'Bahram', caller_phone: '07700900222', message: 'Wants a haircut tomorrow 16:00; booking system was down.', urgency: 'normal' });
    return bye;
  },
  // A bad agent: guesses a price that is not in the profile.
  F1(s) {
    return s.callerTurns.length === 1 ? { text: 'رنگ مو حدوداً سی و پنج پوند می‌شه.' } : bye;
  },
};

test('runner + Worker + judge, scripted agent', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'qa-report-'));
  const provider = fakeProvider(s => SCRIPTS[s.caseId](s));
  const { summary, results } = await runQa({ cases: ['A2', 'A5', 'B1', 'C9', 'F1'], provider, outDir, concurrency: 3 });
  const byId = Object.fromEntries(results.map(r => [r.id, r]));

  for (const id of ['A2', 'A5', 'B1', 'C9']) assert.equal(byId[id].pass, true, `${id}: ${byId[id].failures.join('; ')}`);
  assert.equal(byId.F1.pass, false);
  assert.deepEqual(byId.F1.invented, ['price 35']);

  assert.equal(summary.bookingAccuracy, 1); // A2 and B1 are booking cases
  assert.equal(summary.inventedFacts, 1);
  assert.equal(summary.gate.passed, false);

  const md = readFileSync(join(outDir, 'report.md'), 'utf8');
  assert.match(md, /Booking accuracy/);
  assert.match(md, /### F1/);
  const json = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
  assert.equal(json.results.length, 5);
});
