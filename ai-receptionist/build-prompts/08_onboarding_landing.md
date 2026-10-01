# M8 — Landing page and self-serve onboarding

> Paste `00_master_context.md` first, then this.

## Goal

A business owner finds us, hears a live demo, fills in their details, and gets a working receptionist with minimal help from us.

## Build

1. **Landing page** (Cloudflare Pages, bilingual fa/en, RTL for Persian): headline about never missing a call again, 30-second audio samples of a Persian and an English call (recorded from our demo agent), a "call the demo now" UK number, pricing table read from `plans`, FAQ (privacy, AI disclosure, transfer to a human, cancellation), contact form. Fast (< 1 s LCP on 4G), no tracking cookies without consent.
2. **Onboarding wizard** (after sign-up via the M3 login): steps = business basics → opening hours → services & prices → policies/FAQ → transfer number → voice choice (play samples) → review. Saves `profile_json` (validate with a JSON schema; reuse it in M3 settings).
3. **Preview call**: after the wizard, provision a trial agent (M5) and show "call this number to hear your receptionist", then the forwarding guide for the owner's carrier (BT, Vodafone, EE, O2, Three, Virgin: short how-to per carrier for "forward when busy/no answer").
4. **Trial**: 14 days, then Stripe Checkout (M6). Day 10 reminder with usage stats.
5. Events for the funnel: visit → demo call → sign-up → wizard done → preview call → forwarding on → paid. Store as simple counters (no third-party analytics needed).

## Acceptance

- A test user completes the wizard on a phone in under 15 minutes and receives a working preview number.
- Invalid profiles cannot be saved; the agent prompt renders without empty placeholders.
