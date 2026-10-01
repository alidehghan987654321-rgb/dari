# M7 — Integration with our own booking product (نوبت‌دهی)

> Paste `00_master_context.md` first, then this. Also give the coder read access to the booking product's API docs or code.

## Goal

A business that already uses our appointment-booking product has ONE calendar: bookings made by phone, online and in the shop never clash.

## Build

1. Define the **adapter contract** (`worker/src/providers/README.md`): the receptionist needs exactly these operations — `availability(service_id, date, preferred_time)`, `book(...)`, `findBookings(phone)`, `reschedule(...)`, `cancel(...)` — with the same request/response shapes as today's D1 routes, plus `listServices()` and `getOpeningHours()` so the profile stays in sync.
2. Refactor `index.js` so tools call `getProvider(business)`; `d1` provider = current code, `external` provider = HTTP client for the booking product.
3. On the booking product side (separate repo): add the matching API endpoints, API-key auth per business, and the same conflict rule (atomic, capacity-aware). If its data model differs (staff calendars, resources), map it in the booking product, not in the receptionist.
4. Two-way updates: booking product sends a webhook to `/webhooks/booking-product` on create/cancel/move from other channels, so the receptionist's `find-bookings` and the panel stay correct (or the receptionist reads live from the provider; choose and justify).
5. Service and hours sync: nightly pull + on-demand from the panel; changes trigger M5 `syncAgent`.
6. Fallback: if the external API is down, the agent takes a message (already supported via `ok:false`), and an alert fires (M2).

## Acceptance

- Same slot booked simultaneously via phone (receptionist) and web (booking product) → exactly one succeeds.
- Contract tests run against a mock external provider and against the real booking product staging API.
