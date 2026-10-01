// Usage shown in the owner panel. M3 counts minutes from the calls table for the current calendar month.
// (M4 replaces this with billing periods, plans and limits.)

export async function usageForPanel(env, business, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const r = await env.DB.prepare(
    'SELECT COUNT(*) AS calls, COALESCE(SUM((duration_secs + 59) / 60), 0) AS minutes FROM calls WHERE business_id = ? AND created_at >= ?'
  ).bind(business.id, start.toISOString().slice(0, 19).replace('T', ' ')).first();
  return { period_start: start.toISOString().slice(0, 10), calls: r.calls, minutes_used: r.minutes, included_minutes: null, plan: null };
}
