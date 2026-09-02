# Negotiation engine

`services/api/src/domain/negotiation/engine.ts` (pure decisions) and
`services/api/src/modules/negotiation/service.ts` (persistence, concurrency,
notification).

The defining feature of the product: the customer negotiates with **the
company**. The driver is never a party to it and no driver endpoint reaches this
module.

## Decision bands

Given the company's current position, the internal floor and the auto-accept
threshold:

```
offer ≥ company position   → ACCEPT     they met or beat our number
offer ≥ auto-accept        → ACCEPT     automatically, no human involved
offer ≥ floor              → REVIEW     a human decides (or the system counters)
offer <  floor             → REJECT     below this the trip is not worth running
```

Ordering matters. Acceptance is checked **before** the round limit, so a
customer who has used both offers can still close the deal by meeting our
number. Checking the limit first would trap someone trying to say yes.

An offer **above** the quoted fare is rejected as an input error — almost always
a typo (70,000 for 7,000). Refusing it protects the customer from themselves and
us from the complaint afterwards.

## The two invariants

### 1. The floor never leaks

Every customer-facing string is written so that replaying an entire negotiation
cannot reveal the lowest acceptable price. A rejection says:

> We cannot run this trip at ₦5,000. Our best price is ₦8,000.

not "the minimum is ₦6,800". `internalNote` carries the real reasoning for the
admin console and the audit log; `customerMessage` never does.

There is a test that submits offers across every band and asserts the floor
figure appears in none of the customer messages. If the floor were visible, every
negotiation would collapse to a single move to it and the feature would cost the
company money on every trip.

### 2. The round limit binds the customer only

The customer gets two offers per trip (configurable). **Company counteroffers
are unlimited** — the brief is explicit, and operationally it is what lets a
dispatcher close on the customer's last offer.

## The worked example

From the brief, and asserted as a test:

| Step | Actor | Amount | Outcome |
| --- | --- | --- | --- |
| 1 | TransportCo | ₦8,000 | Quote |
| 2 | Customer | ₦7,000 | Review band (offer 1 of 2) |
| 3 | TransportCo | ₦7,500 | Counter |
| 4 | Customer | ₦7,300 | Review band (offer 2 of 2) |
| 5 | TransportCo | ₦7,400 | Counter |
| 6 | Customer | accepts | **Final fare ₦7,400** |

## Automatic counteroffers

When no dispatcher is on the desk (`adminReviewEnabled: false`), the system
counters instead of leaving the customer waiting:

```
counter = companyPosition − (companyPosition − offer) × meetRatio
        clamped to the floor, rounded UP to ₦50
```

Rounding **up** so rounding never quietly walks the company below where it meant
to stop. If the resulting counter would not sit strictly between the two
positions, the engine accepts instead — a counter that is no better than
accepting is theatre.

## Administrator counters

`validateAdminCounter` refuses a counter that **raises** the price: the company's
position may only move down. A counter below the floor requires an explicit
override, which requires `negotiation:override_floor` and writes an audit entry
with the before and after. Never a silent exception. Even with the override, a
fare below the configured minimum is refused outright.

## Expiry

Offers expire in five minutes, and expiry is **server-authoritative**. A client
countdown is decoration; `expireStaleOffers()` in the scheduler is what actually
closes an offer, every 15 seconds. A client whose timer keeps running past zero
still cannot accept.

`acceptCompanyOffer` requires the `offerId` and checks it, so a customer cannot
accept a price they saw on a stale screen after the company has already moved.

## Concurrency

The race that matters: a customer submits an offer at the same instant a
dispatcher submits a counter. Both read the same state, both decide, both write.

Every path takes `pg_advisory_xact_lock` on the trip and `SELECT … FOR UPDATE`
on the negotiation row, so they serialise. The loser reads the state the winner
produced rather than the state it started from. A `version` column on
`negotiations` gives a second line of defence.

Expired pending offers are swept **before** any evaluation, so a customer whose
counteroffer timed out is never blocked by a ghost.

## What is stored

`negotiation_offers` is append-only: every offer, who made it, the amount, the
message, the status, how it resolved, when it expired and when it was answered.
Nothing is edited or deleted — the complete history is a business record, and it
is what settles a dispute about what was agreed.

## Measuring it

`/admin/reports/kpis` answers the question the feature must justify itself
against: of the customers who haggled, how many closed, at what average
discount, and what did that cost against contribution margin. A high acceptance
rate with a small average discount means the auto-accept band is set well. A
large total discount with a flat trip count means the company is paying for
volume it would have had anyway.
