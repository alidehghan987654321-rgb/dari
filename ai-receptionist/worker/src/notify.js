// Outbound notifications. Failures are logged, never thrown: a failed SMS must not break a booking.

export async function sendTelegram(env, profile, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !profile.telegram_chat_id) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: profile.telegram_chat_id, text: `${profile.business_name}\n${text}`.slice(0, 4000), disable_web_page_preview: true }),
    });
    if (!r.ok) console.error('telegram', r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error('telegram', e);
    return false;
  }
}

// Persian SMS is sent as UCS-2: 70 characters per segment (67 when split). Keep templates short.
export async function sendSms(env, profile, to, body) {
  const from = profile.sms_from || env.TWILIO_FROM;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !from) return false;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    if (!r.ok) console.error('sms', r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error('sms', e);
    return false;
  }
}
