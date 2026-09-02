# Business rules

The rules the platform enforces, and where each one lives in the code. If a rule
here and the code disagree, the code is the bug — but this file is what the code
is supposed to say.

---

## 1. The company owns the fare

The customer negotiates with TransportCo. The driver is never a party to it.

- The fare comes from `domain/pricing/engine.ts`, on the server, from a
  published pricing rule set.
- The customer app posts a pickup and a destination and receives a **quote id**.
  It never sends an amount.
- The driver API exposes `agreedFareMinor` read-only. There is no endpoint
  anywhere that lets a driver change a fare or view a negotiation.

## 2. Negotiation

| Band | Outcome | Reason code |
| --- | --- | --- |
| Offer ≥ company's current position | Accepted | `at_or_above_company_position` |
| Offer ≥ auto-accept threshold (default 5% off) | Accepted automatically | `at_or_above_auto_accept` |
| Between the floor and auto-accept | Human decides, or the system counters | `within_review_band` |
| Below the floor (default 15% off) | Declined automatically | `below_floor` |

- **The customer gets 2 offers per trip** (configurable). The count is checked
  *after* the acceptance paths, so a customer who has used both can still close
  by meeting our number.
- **Company counteroffers are unlimited.** The round cap binds the customer only.
- **The floor never leaks.** Every customer-facing message is written so that
  replaying the whole negotiation cannot reveal the lowest acceptable price.
  There is a test asserting exactly this.
- **Offers expire** (default 5 minutes), server-side. A client countdown is
  decoration; `expireStaleOffers` is what actually closes an offer.
- An administrator may counter **below the floor** only with an explicit
  override, which requires `negotiation:override_floor` and writes an audit row.

## 3. Fare locking

Once agreed, the fare becomes immutable:

- `trips.quoted_fare_minor` can never change — a database trigger refuses it.
- `trips.final_fare_minor` cannot change once `fare_locked_at` is set.
- The original fare, every offer, the final fare and the acceptance timestamp
  are all retained.
- Any exceptional adjustment requires `fare:adjust_locked` and is audited.

## 4. Trip lifecycle

```
REQUESTED → FARE_CALCULATED → NEGOTIATING → FARE_ACCEPTED → FARE_LOCKED
   → DRIVER_ASSIGNED → DRIVER_EN_ROUTE → DRIVER_ARRIVED → TRIP_STARTED
   → TRIP_COMPLETED → PAYMENT_PENDING → PAYMENT_COMPLETED → REVIEW_PENDING
   → COMPLETED
```

Exceptions: `CANCELLED`, `EXPIRED`, `DRIVER_UNAVAILABLE`, `REASSIGNED`,
`PAYMENT_FAILED`, `DISPUTED`, `NO_SHOW`.

Every transition passes `domain/trip/stateMachine.ts`, which checks three things:
the edge exists, the actor may take it, and the preconditions hold. Notably:

- A driver cannot lock a fare. A customer cannot start a trip.
- No driver assignment before the fare is locked.
- **No trip is marked paid without verified payment.** A client claiming
  success is not evidence.
- An administrator with `trip:force_state` may skip a step but cannot invent an
  edge that does not exist, and the override is audited.

## 5. Pricing

```
Fare = base
     + distance × per-km (long-distance rate beyond the threshold)
     + duration × per-minute
     + extra passengers
     + surcharges (peak, night, weekend, holiday, demand, scheduled)
   then minimum fare, then maximum fare, then round up
```

- **Surcharges are additive, not compounding.** Peak (+20%) on a night (+15%)
  trip is +35%, not +38%. Compounding is how a fare becomes indefensible.
- **Published price lists are immutable.** A change is a new version; the old one
  is archived. One published set per zone, enforced by a partial unique index.
- Every quote and every trip stores the `pricing_rule_set_id` and version that
  produced it, so any historical fare can be re-derived exactly.
- The demand multiplier is capped by `demand_multiplier_max` — a fat finger
  cannot triple every fare in the city.

## 6. Cancellation and outstanding balances

Fees come from the rule set that priced **that trip**, not the current one — a
customer is never charged under a policy published after they booked.

| When | Default fee |
| --- | --- |
| Within the grace period (2 min after locking) | ₦0 |
| Before a driver is assigned | ₦0 |
| Scheduled ride, within 1 hour of pickup | ₦500 |
| After assignment | ₦500 |
| Driver en route | ₦800 |
| Driver arrived | ₦1,200 |
| No-show (after a 5 minute wait) | ₦1,500 |

**We do not take a card at sign-up**, so an unpaid fee becomes an
`outstanding_balance` — a visible debt the customer settles deliberately. Above
₦1,000 outstanding, new ride requests are blocked until it is cleared.

## 7. Dispatch

The system **recommends**; a human **assigns**.

Weighted factors: proximity (0.45), workload (0.25), rating (0.15), idle time
(0.15), vehicle readiness (0.0, reserved for the EV fleet).

Picking the nearest driver is explicitly wrong: the nearest driver is often the
one who has already run nine trips today. Every candidate's score is shown with
its reasoning, ineligible drivers are shown **with their exclusion reasons**, and
choosing someone other than the recommendation is recorded as an override so
dispatch quality can be reviewed against outcomes.

A driver is ineligible when offline, suspended, already on a trip, without a
vehicle, with an expired licence, with a conflicting scheduled trip, out of
range, or with a location fix older than 2 minutes.

## 8. Scheduled rides

A driver is committed at booking time, so the customer knows who is coming. The
scheduler dispatches 30 minutes before pickup and reminds both parties an hour
before. If the committed driver has gone offline or been suspended by then, the
trip is flagged `DRIVER_UNAVAILABLE`, operations is alerted, a replacement is
recommended, and the customer is told about the change.

## 9. Payments

- A payment is `succeeded` only after **server-side verification** or a
  **signature-verified webhook**. A database CHECK enforces that a succeeded
  payment has a `verified_at`.
- The verified **amount must match** what was requested; a mismatch fails the
  payment and alerts, rather than settling the trip.
- Webhooks are idempotent on the provider's event id.
- **Cash must equal the locked fare exactly.** A shortfall is an operations
  decision, not something a driver settles at the roadside. Only the assigned
  driver can confirm collection, and it is recorded against them for Finance.
- Card details are never stored — provider tokens only.
- Financial records are never deleted.

## 10. Loyalty

10 points per ₦1,000 **paid** (not quoted — rewarding a negotiated discount
pays twice for the same trip). One point is worth ₦1. Redemption may cover at
most 50% of a fare, so every trip still generates cash for the driver and fuel.

The balance is a projection; the ledger is the truth. Every movement writes a
`loyalty_transactions` row, including admin adjustments and expiries. A unique
index makes a retried settlement a no-op rather than a double award.

## 11. Roles

| Role | Can | Cannot |
| --- | --- | --- |
| Dispatcher | Assign drivers, answer negotiation offers | Break the pricing floor, touch money or payroll |
| Finance | Refund, reconcile, write off balances | Change pricing |
| Customer Support | Read customer PII, handle tickets, cancel | Refund, change pricing |
| HR | Employee records, payroll preparation | See customer PII, approve payroll |
| Operations Manager | Run operations end to end | Payroll, refunds |
| Management | Read everything | Write anything operational |
| Driver | Their own trips | Everything else |

Separations of duty enforced by the database, not only by convention: a refund
approver cannot be the requester, and a payroll approver cannot be the preparer.

## 12. Safety

SOS writes the incident row **first**, then notifies. If every notification
channel is down the incident still exists and appears on the operations board.
The emergency hotline is returned in the response so the user can call a human
immediately, whatever our systems are doing.

## 13. Fraud

Rules and audit trails, not a model — at four vehicles there is no training
data, and an unexplainable score is useless to someone who has to confront a
specific driver about a specific trip.

Signals: GPS jumps above 200 km/h, completion without movement, route deviation
beyond 1.6×, repeated cancellations, duplicate sign-up devices, and — the ones
nobody likes to write down — administrator refund velocity, fare-override
velocity and self-approval.
