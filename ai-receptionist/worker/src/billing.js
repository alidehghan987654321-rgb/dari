// M6 — billing with Stripe, over plain fetch + Web Crypto (no Node SDK in the Worker).
// Field names follow the official stripe-node SDK for API version 2026-08-26.dahlia: a Subscription's
// current period lives on its items, and an Invoice points at its subscription through
// parent.subscription_details. Pin the version with STRIPE_API_VERSION.
//
// Overage: at each renewal Stripe creates a draft invoice (billing_reason subscription_cycle) about an hour before
// finalizing it. On invoice.created we add one invoice item for the minutes over the plan in the period that just
// ended, computed from our own usage table. Chosen over Billing Meters because it needs no meter objects, no
// metered prices and no per-call reporting, and our usage table stays the single source of truth.
//
// VAT: PRICES_INCLUDE_VAT ("true"/"false") sets the prices' tax_behavior. TODO(business decision): automatic tax
// and VAT registration are not decided yet, so automatic_tax is not enabled. Checkout collects the business
// address and VAT number either way.

import { safeEqual } from './lib.js';
import { upsertSubscription, applyUsageRules, sendTrackedSms } from './usage.js';
import { loadBusiness } from './bookings.js';
import { sendTelegram } from './notify.js';

export const STRIPE_API_VERSION = '2026-08-26.dahlia';
export const billingConfigured = env => !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);

export class BillingError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// ---------------- pure ----------------

/** Stripe's form encoding: { a: { b: [ { c: 1 } ] } } -> a[b][0][c]=1. */
export function encodeForm(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? encodeForm(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') encodeForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

/** Stripe-Signature: "t=<unix>,v1=<hex>[,v1=...]" over `${t}.${payload}`, 5-minute tolerance. */
export async function verifyStripeSignature(secret, header, payload, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) {
  if (!secret || !header) return false;
  let t = null;
  const sigs = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=').map(x => x?.trim());
    if (k === 't') t = Number(v);
    if (k === 'v1' && v) sigs.push(v);
  }
  if (!t || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return sigs.some(s => safeEqual(s, expected));
}

/** Stripe subscription status -> ours. */
export function mapStatus(s) {
  return {
    trialing: 'trial', active: 'active', past_due: 'past_due', unpaid: 'past_due', incomplete: 'past_due',
    paused: 'paused', canceled: 'cancelled', incomplete_expired: 'cancelled',
  }[s] || 'past_due';
}

const isoDate = unix => new Date(unix * 1000).toISOString().slice(0, 10);

/** Our subscription row from a Stripe Subscription (period from its items). */
export function subscriptionRow(sub, planId) {
  const items = sub.items?.data || [];
  const start = Math.min(...items.map(i => i.current_period_start).filter(Boolean));
  const end = Math.max(...items.map(i => i.current_period_end).filter(Boolean));
  return {
    plan_id: planId,
    status: mapStatus(sub.status),
    period_start: Number.isFinite(start) ? isoDate(start) : null,
    period_end: Number.isFinite(end) ? isoDate(end) : null,
    trial_end: sub.trial_end ? isoDate(sub.trial_end) : null,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    stripe_subscription_id: sub.id,
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
  };
}

/** Overage for a finished period. Pure. */
export function overageCharge(plan, billedMinutes) {
  const minutes = Math.max(0, billedMinutes - plan.included_minutes);
  return { minutes, amount: minutes * plan.overage_per_min };
}

// ---------------- Stripe API ----------------

async function stripe(env, method, path, params, idempotencyKey) {
  const base = (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');
  const qs = method === 'GET' && params ? `?${encodeForm(params)}` : '';
  const headers = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'stripe-version': env.STRIPE_API_VERSION || STRIPE_API_VERSION };
  if (method !== 'GET') headers['content-type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const r = await fetch(`${base}${path}${qs}`, { method, headers, body: method === 'GET' || !params ? undefined : encodeForm(params) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new BillingError('stripe_error', `Stripe ${method} ${path} -> ${r.status}: ${data.error?.message || ''}`, 502);
  return data;
}

/** POST /admin/stripe/setup: a Product + monthly Price per plan, found again by lookup_key (idempotent). */
export async function setupStripe(env) {
  if (!env.STRIPE_SECRET_KEY) throw new BillingError('not_configured', 'Set STRIPE_SECRET_KEY first.');
  const plans = (await env.DB.prepare('SELECT * FROM plans WHERE active = 1').all()).results || [];
  const out = [];
  for (const p of plans) {
    const lookup = `receptionist_${p.id}`;
    let price = (await stripe(env, 'GET', '/v1/prices', { lookup_keys: [lookup], active: true })).data?.[0];
    if (!price || price.unit_amount !== p.monthly_price || price.currency !== p.currency.toLowerCase()) {
      const product = await stripe(env, 'POST', '/v1/products', { name: `AI receptionist — ${p.name}`, metadata: { plan_id: p.id } }, `product-${p.id}-${p.monthly_price}`);
      price = await stripe(env, 'POST', '/v1/prices', {
        product: product.id, unit_amount: p.monthly_price, currency: p.currency.toLowerCase(),
        recurring: { interval: 'month' }, lookup_key: lookup, transfer_lookup_key: true,
        tax_behavior: env.PRICES_INCLUDE_VAT === 'true' ? 'inclusive' : 'exclusive', metadata: { plan_id: p.id },
      }, `price-${p.id}-${p.monthly_price}`);
    }
    await env.DB.prepare('UPDATE plans SET stripe_price_id = ? WHERE id = ?').bind(price.id, p.id).run();
    out.push({ plan_id: p.id, price_id: price.id });
  }
  return { prices: out };
}

/** Panel "start subscription": a Checkout Session in subscription mode. Any trial days left are carried over. */
export async function createCheckout(env, business, user, planId, origin) {
  if (!billingConfigured(env)) throw new BillingError('not_configured', 'Billing is not set up yet.');
  const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').bind(planId).first();
  if (!plan?.stripe_price_id) throw new BillingError('unknown_plan', 'Unknown plan, or prices not set up (POST /admin/stripe/setup).');
  const sub = await env.DB.prepare('SELECT * FROM subscriptions WHERE business_id = ?').bind(business.id).first();
  if (sub?.stripe_subscription_id && sub.status !== 'cancelled') throw new BillingError('already_subscribed', 'Use the billing portal to change the plan.', 409);

  const params = {
    mode: 'subscription',
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    success_url: `${origin}/panel/#/account?checkout=success`,
    cancel_url: `${origin}/panel/#/account?checkout=cancel`,
    client_reference_id: business.id,
    metadata: { business_id: business.id },
    subscription_data: { metadata: { business_id: business.id, plan_id: plan.id } },
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
  };
  // A trial that is still running (pilot or self-serve) continues in Stripe; a used-up trial is not repeated.
  const trialEnd = sub?.status === 'trial' && sub.trial_end ? Math.floor(Date.parse(`${sub.trial_end}T23:59:59Z`) / 1000) : 0;
  if (trialEnd > Date.now() / 1000 + 48 * 3600) params.subscription_data.trial_end = trialEnd; // Stripe needs ≥ 48 h ahead
  if (sub?.stripe_customer_id) {
    params.customer = sub.stripe_customer_id;
    params.customer_update = { address: 'auto', name: 'auto' }; // required with tax_id_collection on an existing customer
  } else if (user.email) {
    params.customer_email = user.email;
  }
  const session = await stripe(env, 'POST', '/v1/checkout/sessions', params);
  return { url: session.url };
}

/** Panel "invoices and payment": the Stripe Customer Portal. */
export async function createPortal(env, business, origin) {
  if (!billingConfigured(env)) throw new BillingError('not_configured', 'Billing is not set up yet.');
  const sub = await env.DB.prepare('SELECT stripe_customer_id FROM subscriptions WHERE business_id = ?').bind(business.id).first();
  if (!sub?.stripe_customer_id) throw new BillingError('no_customer', 'Start a subscription first.', 409);
  const s = await stripe(env, 'POST', '/v1/billing_portal/sessions', { customer: sub.stripe_customer_id, return_url: `${origin}/panel/#/account` });
  return { url: s.url };
}

// ---------------- webhook ----------------

async function businessForSubscription(env, sub) {
  if (sub.metadata?.business_id) return sub.metadata.business_id;
  const row = await env.DB.prepare('SELECT business_id FROM subscriptions WHERE stripe_subscription_id = ?').bind(sub.id).first();
  return row?.business_id ?? null;
}

async function syncFromStripe(env, businessId, subscriptionId) {
  const sub = await stripe(env, 'GET', `/v1/subscriptions/${subscriptionId}`);
  businessId ||= await businessForSubscription(env, sub);
  if (!businessId) return null;
  const priceId = sub.items?.data?.[0]?.price?.id;
  const plan = await env.DB.prepare('SELECT id FROM plans WHERE stripe_price_id = ?').bind(priceId).first();
  const row = subscriptionRow(sub, plan?.id ?? sub.metadata?.plan_id ?? 'basic');
  const prev = await env.DB.prepare('SELECT status FROM subscriptions WHERE business_id = ?').bind(businessId).first();
  const r = await upsertSubscription(env, { business_id: businessId, ...row });
  if (!r.ok) throw new BillingError('bad_subscription', r.error);
  await env.DB.prepare('UPDATE subscriptions SET stripe_customer_id = ?, stripe_subscription_id = ?, cancel_at_period_end = ? WHERE business_id = ?')
    .bind(row.stripe_customer_id, row.stripe_subscription_id, row.cancel_at_period_end, businessId).run();
  const business = await loadBusiness(env, businessId);
  if (business) await applyUsageRules(env, business); // message-only on/off (M4 grace period)
  return { business, status: row.status, previous: prev?.status ?? null };
}

async function notifyPaymentFailed(env, business) {
  const p = business.profile;
  const fa = (p.languages || ['fa'])[0] !== 'en';
  const text = fa
    ? 'پرداخت اشتراک منشی انجام نشد. لطفاً کارت را در پنل (حساب ← فاکتورها و پرداخت) به‌روز کنید. منشی تا ۳ روز عادی کار می‌کند.'
    : 'Your receptionist subscription payment failed. Please update your card in the panel (Account -> Invoices and payment). Service continues normally for 3 days.';
  await sendTelegram(env, p, text);
  const owners = (await env.DB.prepare("SELECT phone FROM users WHERE business_id = ? AND role = 'owner' AND phone IS NOT NULL").bind(business.id).all()).results || [];
  for (const o of owners) await sendTrackedSms(env, business.id, p, o.phone, text, 'billing');
}

/** invoice.created for a renewal: add the finished period's overage to the draft invoice, once. */
async function chargeOverage(env, invoice) {
  if (invoice.billing_reason !== 'subscription_cycle' || invoice.status !== 'draft') return null;
  const subId = invoice.parent?.subscription_details?.subscription;
  if (!subId) return null;
  const row = await env.DB.prepare(
    `SELECT s.business_id, p.* FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.stripe_subscription_id = ?`
  ).bind(typeof subId === 'string' ? subId : subId.id).first();
  if (!row) return null;
  const from = new Date(invoice.period_start * 1000).toISOString();
  const to = new Date(invoice.period_end * 1000).toISOString();
  const used = await env.DB.prepare('SELECT COALESCE(SUM(billed_minutes), 0) AS m FROM usage WHERE business_id = ? AND created_at >= ? AND created_at < ?')
    .bind(row.business_id, from, to).first();
  const { minutes, amount } = overageCharge(row, used.m);
  if (!amount) return { minutes: 0 };
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO billing_overage (business_id, period_start, period_end, minutes, amount, stripe_invoice, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
  ).bind(row.business_id, from, to, minutes, amount, invoice.id).run();
  if (claim.meta?.changes !== 1) return { duplicate: true };
  try {
    const item = await stripe(env, 'POST', '/v1/invoiceitems', {
      customer: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id,
      invoice: invoice.id, amount, currency: row.currency.toLowerCase(),
      description: `Extra minutes: ${minutes} × ${row.overage_per_min / 100} ${row.currency} (${from.slice(0, 10)} – ${to.slice(0, 10)})`,
      metadata: { business_id: row.business_id, minutes: String(minutes) },
    }, `overage-${row.business_id}-${from}`);
    await env.DB.prepare('UPDATE billing_overage SET stripe_item = ? WHERE business_id = ? AND period_start = ?').bind(item.id, row.business_id, from).run();
    return { minutes, amount };
  } catch (e) {
    await env.DB.prepare('DELETE FROM billing_overage WHERE business_id = ? AND period_start = ?').bind(row.business_id, from).run();
    throw e;
  }
}

/** POST /webhooks/stripe. Returns { status, body }. */
export async function stripeWebhook(env, request) {
  const raw = await request.text();
  if (!(await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, request.headers.get('stripe-signature'), raw))) {
    return { status: 400, body: { ok: false, error: 'bad_signature' } };
  }
  const evt = JSON.parse(raw);
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, datetime('now'))").bind(evt.id, evt.type).run();
  if (claim.meta?.changes !== 1) return { status: 200, body: { ok: true, duplicate: true } };

  try {
    const o = evt.data.object;
    let result = null;
    switch (evt.type) {
      case 'checkout.session.completed':
        if (o.mode === 'subscription' && o.subscription) result = await syncFromStripe(env, o.client_reference_id || o.metadata?.business_id, o.subscription);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        result = await syncFromStripe(env, o.metadata?.business_id, o.id);
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const subId = o.parent?.subscription_details?.subscription;
        if (subId) result = await syncFromStripe(env, null, typeof subId === 'string' ? subId : subId.id);
        if (evt.type === 'invoice.payment_failed' && result?.business) await notifyPaymentFailed(env, result.business);
        break;
      }
      case 'invoice.created':
        result = await chargeOverage(env, o);
        break;
      default:
        break;
    }
    return { status: 200, body: { ok: true, type: evt.type, status: result?.status } };
  } catch (e) {
    // Let Stripe retry: forget the event so the retry is processed.
    await env.DB.prepare('DELETE FROM stripe_events WHERE id = ?').bind(evt.id).run();
    console.error(JSON.stringify({ evt: 'stripe_webhook_failed', type: evt.type, error: String(e?.message || e) }));
    return { status: 500, body: { ok: false, error: 'processing_failed' } };
  }
}
