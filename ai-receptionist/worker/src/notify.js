// Outbound notifications. Failures are logged, never thrown: a failed SMS must not break a booking.
// Each sender returns true (sent), false (failed) or null (channel not configured, nothing attempted).
// Logs carry only the HTTP status and the provider's error code: response bodies can echo phone numbers.
// TELEGRAM_API_BASE / TWILIO_API_BASE exist so tests can point the Worker at a local mock.

const telegramBase = env => (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const twilioBase = env => (env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');

async function providerError(r) {
  try {
    const j = await r.json();
    return j.code ?? j.error_code ?? j.error ?? '';
  } catch {
    return '';
  }
}

export async function telegramTo(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return null;
  try {
    const r = await fetch(`${telegramBase(env)}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
    if (!r.ok) console.error(JSON.stringify({ evt: 'notify_failed', channel: 'telegram', status: r.status, code: await providerError(r) }));
    return r.ok;
  } catch (e) {
    console.error(JSON.stringify({ evt: 'notify_failed', channel: 'telegram', error: String(e?.message || e) }));
    return false;
  }
}

export function sendTelegram(env, profile, text) {
  return telegramTo(env, profile.telegram_chat_id, `${profile.business_name}\n${text}`);
}

/** Message to our own team chat (monitoring alerts). */
export function sendTeamAlert(env, text) {
  return telegramTo(env, env.TEAM_ALERT_CHAT_ID, text);
}

// Persian SMS is sent as UCS-2: 70 characters per segment (67 when split). Keep templates short.
export async function sendSms(env, profile, to, body) {
  const from = profile?.sms_from || env.TWILIO_FROM;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !from) return null;
  try {
    const r = await fetch(`${twilioBase(env)}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    if (!r.ok) console.error(JSON.stringify({ evt: 'notify_failed', channel: 'sms', status: r.status, code: await providerError(r) }));
    return r.ok;
  } catch (e) {
    console.error(JSON.stringify({ evt: 'notify_failed', channel: 'sms', error: String(e?.message || e) }));
    return false;
  }
}
