# Roadmap

## Status

| Area | State |
| --- | --- |
| Monorepo, shared types, validation, config, brand tokens | Complete |
| Database schema and migrations | Complete |
| Pricing engine + tests | Complete |
| Negotiation engine + tests | Complete |
| Trip state machine + tests | Complete |
| Dispatch scoring + tests | Complete |
| Loyalty and RBAC + tests | Complete |
| Authentication, OTP, sessions, RBAC enforcement | Complete |
| Customer API: quote, trip, negotiate, cancel, review, balances | Complete |
| Driver API: state, location, trip actions, cash | Complete |
| Admin API: dashboard, live, dispatch, negotiation, pricing, people, finance, payroll, reports, audit | Complete |
| Payments: Paystack, Flutterwave, cash, webhooks, reconciliation | Complete |
| Realtime gateway with room authorisation | Complete |
| Background scheduler | Complete |
| Admin console | Complete |
| Customer app: auth, home, booking, fare/negotiation, trip, support, balance | Complete |
| Driver app: auth, dashboard, trip, history, adaptive location | Complete |
| Documentation | Complete |

**Test coverage: 118 unit tests, plus a 51-assertion end-to-end walkthrough
(`pnpm --filter @transportco/api smoke`) verified against a live PostgreSQL.**

Verified end to end on a real database: migrations, seed, registration and OTP,
server-side quoting, all three negotiation bands, admin counteroffer, floor
override refusal, fare locking (including the database trigger refusing a direct
SQL update), dispatch scoring and assignment, the full driver flow, cash
collection with amount matching, loyalty accrual, rating, permission boundaries
and the audit trail.

## Before the pilot

Ordered by what blocks a real customer.

1. **Google Places autocomplete** in the customer app. The booking screen ships
   a working landmark picker; real address search replaces `DestinationPicker`
   and nothing downstream changes, because the flow already speaks coordinates.
2. **Live maps** in both apps and on the operations board. The data is already
   there — driver positions stream over realtime today.
3. **SMS provider** (Termii or similar). The adapter and channel policy exist;
   they log rather than send until credentials land. Blocks OTP delivery, so it
   blocks real sign-ups.
4. **Push credentials** for both apps.
5. **Payment provider integration testing** against live keys, end to end,
   including a redelivered webhook and a deliberate amount mismatch.
6. **Automated integration tests in CI.** The walkthrough in
   `services/api/scripts/smoke.cjs` covers the critical path and passes against
   a live database, but it runs manually against a started API; it should become
   a CI job with an ephemeral database.
7. **Staff 2FA** before more people hold console accounts.

## Phase 1.5 — operational hardening

- Redis for rate limiting, and either a leader election or an external scheduler,
  the moment a second API instance exists.
- Partition `trip_locations` and `driver_locations` by month; archive beyond 90
  days. Needed around a hundred drivers, not four.
- Retention policy for location history.
- Read replica for reporting once KPI queries start competing with dispatch.
- Sentry or equivalent for error tracking.

## Phase 2

Architecture is prepared for these; none is a Phase 1 blocker.

| Feature | What already exists |
| --- | --- |
| Airport transport, flight tracking, meet-and-greet | Scheduled rides, landmark destinations |
| Customer wallet | Payment abstraction, loyalty ledger |
| Corporate accounts | Customer model, outstanding balances |
| Referral rewards | `referral_code`, `referred_by_customer_id`, loyalty ledger |
| Membership tiers | `loyalty_accounts.tier`, `tierForLifetimePoints` |
| Promotions and vouchers | Pricing versioning, redemption model |
| Fleet maintenance | `vehicles.next_service_due_at`, `health_status` |
| Advanced analytics | KPI endpoint, contribution margin, CSV export |

## The EV fleet

TransportCo intends to develop its own electric vehicles with manufacturers in
China. The schema carries that from day one rather than as a later migration:

`vehicles.powertrain`, `battery_percent`, `estimated_range_metres`,
`charging_status`, `odometer_metres`, `last_telemetry_at`, `health_status`,
`next_service_due_at`.

Dispatch already reads them: `vehicleReadiness` is a scored factor weighted at
zero. Enabling it is a weight change, plus a telemetry ingestion endpoint. The
range formula is already implemented — trip out, trip back, plus a margin.

Still to build when the vehicles exist: telemetry ingestion, charging-station
records, charging history, and a maintenance module.

## Scale checkpoints

| Fleet | What changes |
| --- | --- |
| 4 vehicles (today) | Single API instance, in-process scheduler. Correct for now. |
| ~20 | Redis, external scheduler, staff 2FA, location partitioning |
| ~100 | Read replica, per-zone pricing in real use, dispatch batching, archived location history |
| ~1,000 | Dispatch as its own service, event streaming instead of in-process fan-out, sharded location storage, regional deployments |

The domain layer should survive all four unchanged. That is the point of keeping
it pure.
