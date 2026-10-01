# M6 — Billing with Stripe

> Paste `00_master_context.md` first, then this.

## Goal

Businesses pay monthly by card after a 14-day free trial; failed payments are handled automatically; we never touch card data.

## Build

1. Stripe Products/Prices for each plan (create via a setup script reading `plans`; read current Stripe docs for subscriptions with usage-based overage — metered prices or invoice items, choose the simplest that works today and explain why).
2. **Checkout**: panel button "شروع اشتراک" → Stripe Checkout session (subscription mode, trial already used if the pilot counted) → success page.
3. **Customer Portal** link in the panel account page (update card, invoices, cancel).
4. **Webhook** `POST /webhooks/stripe` (verify signature with the Stripe signing secret, using Web Crypto, no Node SDK requirement): handle `checkout.session.completed`, `customer.subscription.updated/deleted`, `invoice.paid`, `invoice.payment_failed`. Update `subscriptions.status`; on `past_due` notify owner; M4 grace-period logic handles service.
5. Overage: at period end, report billed overage minutes from M4 `usage` to Stripe (usage record / meter event or invoice item, per current API).
6. VAT: prices shown ex-VAT or inc-VAT according to a config flag; collect business address and VAT number in Checkout. (Our VAT registration status is a business decision; leave a TODO, do not guess.)
7. Idempotency: store processed Stripe event ids.

## Acceptance

- In Stripe test mode: trial → paid → payment failure → recovery → cancellation all reflected in `subscriptions` and in the panel.
- Replayed webhooks are ignored safely; invalid signatures rejected.
