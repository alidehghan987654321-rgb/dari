import test from 'node:test';
import assert from 'node:assert/strict';
import { billedMinutes, callCost, usageRules, marginReport, calendarPeriod } from '../src/usage.js';
import { smsSegments, bookingSms } from '../src/lib.js';

const basic = { id: 'basic', name: 'Basic', currency: 'GBP', monthly_price: 7900, included_minutes: 300, overage_per_min: 25 };
const pro = { id: 'pro', name: 'Pro', currency: 'GBP', monthly_price: 14900, included_minutes: 600, overage_per_min: 20 };
const rates = { voice_per_min: 9, llm_per_min: 2, telephony_per_min: 1.3, sms_per_segment: 4 };
const now = new Date('2026-10-20T12:00:00Z');

test('per-call rounding and cost estimate', () => {
  assert.deepEqual([0, 1, 59, 60, 61, 130, 600].map(billedMinutes), [0, 1, 1, 1, 2, 3, 10]);
  assert.equal(billedMinutes(-5), 0);
  const c = callCost(90, rates); // 1.5 exact minutes
  assert.deepEqual([c.voice, c.llm, Math.round(c.telephony * 100) / 100], [13.5, 3, 1.95]);
  assert.deepEqual(calendarPeriod(now), { start: '2026-10-01', end: '2026-11-01' });
});

test('SMS segments: Persian is UCS-2', () => {
  assert.equal(smsSegments('a'.repeat(160)), 1);
  assert.equal(smsSegments('a'.repeat(161)), 2);
  assert.equal(smsSegments('س'.repeat(70)), 1);
  assert.equal(smsSegments('س'.repeat(71)), 2);
  assert.equal(smsSegments('س'.repeat(134)), 2);
  assert.equal(smsSegments('س'.repeat(135)), 3);
  const fa = bookingSms({ lang: 'fa', businessName: 'Pars Barbers', serviceName: 'x', date: '2026-10-08', time: '12:00', id: 'K7QX2M' });
  assert.ok(smsSegments(fa) <= 2, 'the Persian confirmation stays within 2 segments');
});

test('rules: 80% and 100% notices once per period', () => {
  assert.deepEqual(usageRules({ plan: basic, usedMinutes: 239 }).notify, []);
  assert.deepEqual(usageRules({ plan: basic, usedMinutes: 240 }).notify, ['80']);
  assert.deepEqual(usageRules({ plan: basic, usedMinutes: 300 }).notify, ['80', '100']);
  assert.deepEqual(usageRules({ plan: basic, usedMinutes: 310, sent: ['80'] }).notify, ['100']);
  assert.deepEqual(usageRules({ plan: basic, usedMinutes: 310, sent: ['80', '100'] }).notify, []);
  assert.deepEqual(usageRules({ plan: null, usedMinutes: 5000 }).notify, [], 'no plan, no limits');
});

test('rules: hard cap and payment grace switch to message-only', () => {
  assert.equal(usageRules({ plan: basic, usedMinutes: 400 }).messageOnly, false, 'overage keeps answering by default');
  assert.deepEqual(usageRules({ plan: basic, usedMinutes: 300, hardCap: true }), { notify: ['80', '100'], messageOnly: true, reason: 'hard_cap' });
  assert.equal(usageRules({ plan: basic, usedMinutes: 299, hardCap: true }).messageOnly, false);

  const at = days => new Date(+now - days * 864e5).toISOString();
  for (const status of ['past_due', 'paused']) {
    assert.equal(usageRules({ plan: basic, sub: { status, status_changed_at: at(2.9) }, usedMinutes: 0, now }).messageOnly, false, `${status}: still in grace`);
    assert.deepEqual(usageRules({ plan: basic, sub: { status, status_changed_at: at(3) }, usedMinutes: 0, now }).reason, status);
  }
  assert.equal(usageRules({ plan: basic, sub: { status: 'cancelled', status_changed_at: at(0) }, usedMinutes: 0, now }).reason, 'cancelled');
  assert.equal(usageRules({ plan: basic, sub: { status: 'active', status_changed_at: at(10) }, usedMinutes: 0, now }).messageOnly, false);
});

test('margin report matches a hand-calculated example', () => {
  // A: Basic, active. 350 billed minutes (50 over), costs from 340 exact minutes, 120 SMS segments.
  //    revenue = 7900 + 50 × 25 = 9150p
  //    cost    = 340 × 9 + 340 × 2 + 340 × 1.3 + 120 × 4 = 3060 + 680 + 442 + 480 = 4662p
  //    margin  = 4488p (49.0%)
  // B: Pro, trial (free). 100 minutes, costs from 100 exact minutes, 10 segments.
  //    revenue = 0; cost = 900 + 200 + 130 + 40 = 1270p; margin = −1270p
  // C: no subscription, no usage.
  const rows = [
    { business_id: 'a', plan: basic, status: 'active', minutes: 350, cost_voice: 3060, cost_llm: 680, cost_telephony: 442, sms_segments: 120 },
    { business_id: 'b', plan: pro, status: 'trial', minutes: 100, cost_voice: 900, cost_llm: 200, cost_telephony: 130, sms_segments: 10 },
    { business_id: 'c', plan: null, status: null, minutes: 0, cost_voice: 0, cost_llm: 0, cost_telephony: 0, sms_segments: 0 },
  ];
  const r = marginReport(rows, rates);
  const [a, b, c] = r.businesses;
  assert.deepEqual([a.revenue, a.cost, a.margin, a.margin_pct, a.overage_minutes], [9150, 4662, 4488, 49, 50]);
  assert.deepEqual(a.cost_breakdown, { voice: 3060, llm: 680, telephony: 442, sms: 480 });
  assert.deepEqual([b.revenue, b.cost, b.margin, b.margin_pct], [0, 1270, -1270, null]);
  assert.deepEqual([c.revenue, c.cost, c.margin], [0, 0, 0]);
  assert.deepEqual(r.totals, { revenue: 9150, cost: 5932, margin: 3218, minutes: 450 });
});
