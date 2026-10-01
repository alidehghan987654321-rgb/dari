// Transactional email (login codes, usage warnings) through Resend's HTTP API: one POST, no SDK.
// Swap the provider here if needed. Returns true (sent), false (failed) or null (not configured).
// Vars: RESEND_API_KEY (secret), EMAIL_FROM (e.g. "Receptionist <noreply@yourdomain>"); EMAIL_API_BASE for tests.

export async function sendEmail(env, to, subject, text) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return null;
  try {
    const r = await fetch(`${(env.EMAIL_API_BASE || 'https://api.resend.com').replace(/\/$/, '')}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
    });
    if (!r.ok) console.error(JSON.stringify({ evt: 'notify_failed', channel: 'email', status: r.status }));
    return r.ok;
  } catch (e) {
    console.error(JSON.stringify({ evt: 'notify_failed', channel: 'email', error: String(e?.message || e) }));
    return false;
  }
}
