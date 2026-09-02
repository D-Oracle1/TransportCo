# Architecture

## The shape of the system

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  Customer app    │   │   Driver app     │   │  Admin console   │
│  Expo / RN       │   │   Expo / RN      │   │  Next.js         │
└────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
         │  HTTPS + WebSocket   │                      │ httpOnly cookie
         └──────────────┬───────┴──────────────────────┘
                        ▼
              ┌───────────────────────┐
              │   TransportCo API     │   Node + Express + TypeScript
              │  ┌─────────────────┐  │
              │  │  domain/        │  │   Pure business logic, no I/O
              │  │  modules/       │  │   HTTP + persistence per area
              │  │  services/      │  │   Payments, maps, notifications
              │  └─────────────────┘  │
              └───────────┬───────────┘
                          ▼
                  ┌───────────────┐
                  │  PostgreSQL   │
                  └───────────────┘
```

Everything of consequence happens in the API. The three clients are rendering
surfaces: they display what the server decided and collect what the user typed.

## Why a monorepo

Three applications share one domain. `TripStatus`, the negotiation offer shape
and the money representation must mean the same thing in all three, and a fare
formatted differently in the customer app than in the driver app is a support
ticket waiting to happen.

`packages/types` is the single definition. `packages/validation` holds the Zod
schemas that both the client form and the server route use, so a form cannot
pass locally and be rejected remotely for a different reason.

## Layering inside the API

```
routes      HTTP shape, permission checks, serialisation
   │
modules     Orchestration: transactions, notifications, realtime fan-out
   │
domain      Pure functions: pricing, negotiation, dispatch scoring, state machine
   │
db          SQL
```

**The `domain` layer has no imports from `modules`, `services` or `db`.** It
takes plain inputs and returns plain outputs. That is what makes the pricing
engine testable exhaustively without a database, and what lets a fare from 2026
be recomputed identically in 2028.

The dependency rule is one-directional and worth defending: the moment a domain
function needs to "just check the database", the business rule stops being
reviewable in isolation.

## Where the authority lives

| Decision | Decided by | Why not the client |
| --- | --- | --- |
| Fare | `domain/pricing/engine.ts` | A client-computed fare is a fare the customer can edit |
| Negotiation outcome | `domain/negotiation/engine.ts` | The floor must never leave the server |
| Trip state | `domain/trip/stateMachine.ts` | Clients disagree; the database cannot |
| Driver assignment | `modules/dispatch` | Drivers do not pick their own work |
| Payment success | `services/payments` | Only a verified provider callback is evidence |
| Loyalty points | `modules/payments/settlement.ts` | Points are money |
| Permissions | JWT claims minted from the database | A client-supplied role is not a role |

## Concurrency

Four situations that will happen and must not corrupt anything:

**Two dispatchers assign the same trip.** Each trip row carries a `version`.
Assignment takes an advisory lock, checks the version, and increments it. The
second write matches zero rows and raises `version_conflict`, which the console
surfaces as "this trip was changed by someone else".

**A customer offer and an admin counter land together.** Both take
`pg_advisory_xact_lock` on the negotiation, so they serialise. The second reads
the state the first produced rather than the state it started from.

**A payment webhook is delivered twice.** Provider events carry a stable id
which is the primary key of `webhook_events`; the second insert does nothing.
Below that, `payment_transactions.idempotency_key` is unique, so even a
different delivery path cannot double-credit.

**A phone retries a request after a dropped response.** Unsafe endpoints accept
`Idempotency-Key`. The first request records the key, the retry replays the
stored response. Same key with a different body is rejected — that is a client
bug and hiding it helps nobody.

## Realtime

Socket.IO, with rooms as the authorisation boundary:

| Room | Who may join |
| --- | --- |
| `customer:<id>` | that customer |
| `driver:<id>` | that driver |
| `trip:<id>` | the trip's customer, its driver, and staff with `trip:read` |
| `ops` | staff with `trip:read` |

Membership is checked against the database at join time, so a driver removed
from a trip stops receiving its location immediately.

Every envelope carries a per-room sequence number. A client that sees a gap
refetches rather than rendering a stale position as current. Both mobile apps
also poll as a floor — on a Nigerian mobile network the socket will drop, and a
customer watching a frozen map does not care why.

## Background work

`workers/scheduler.ts` runs interval jobs in-process: expiring offers and
quotes, dispatching scheduled rides, sending reminders, reconciling payments the
provider never called back about, marking stale drivers offline, expiring
loyalty points and housekeeping.

Every job is idempotent, so moving to a real queue later changes the trigger and
nothing else. An in-process scheduler is honest for one pilot instance; running
several API nodes requires either a leader election or an external scheduler,
and that is the first thing to change when the fleet grows.

## Failure posture

- **Configuration** is validated at boot; an invalid deployment refuses to start.
- **Provider outages** raise `provider_unavailable`, retried with backoff and
  full jitter.
- **Notification failures never roll back business outcomes** — a trip completes
  even if the push fails, and the attempt is recorded.
- **The database is the last line.** Constraints, partial unique indexes and
  triggers enforce the invariants that matter (one active assignment per trip,
  one published price list per zone, an immutable locked fare, an append-only
  audit log). Application discipline is the first line, not the only one.

## Decisions worth revisiting

| Decision | Why it is right now | When to revisit |
| --- | --- | --- |
| In-process rate limiting | One instance, no Redis to operate | Second API instance |
| In-process scheduler | Same | Second API instance |
| Raw SQL, no ORM | Locking and row counts stay visible | If the team grows past its SQL comfort |
| Circular zones | Two zones, both circular | Real zone boundaries that matter for pricing |
| Polling alongside realtime | Networks here genuinely drop | Never — keep the floor |
