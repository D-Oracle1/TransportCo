# Database

PostgreSQL 14+. Migrations live in `services/api/migrations` and run in filename
order, each in a transaction, with its checksum recorded. **An applied migration
is immutable** — editing one is refused, because a schema that differs between
staging and production because someone "just tweaked" an old file is a genuinely
dangerous class of bug.

```bash
pnpm db:migrate           # apply pending
pnpm --filter @transportco/api db:migrate status
pnpm db:reset             # drop + migrate + seed (refuses in production)
```

## Conventions

| Convention | Why |
| --- | --- |
| UUID primary keys (`gen_random_uuid()`) | Safe to expose; no enumeration |
| **Money as `BIGINT` in kobo** | Integers only. Floating point never touches a fare |
| `TEXT` + `CHECK` instead of `ENUM` | Adding a status is an ordinary migration, not a type rewrite |
| `created_at` / `updated_at` everywhere | `updated_at` maintained by trigger, not by writer discipline |
| Soft delete only where audit needs it | `users`, `employees`, `drivers`, `vehicles` |
| Partial unique indexes | Express "at most one active X" precisely |

`BIGINT` is parsed as a JavaScript number. A ₦10,000,000 fare is 10⁹ kobo — nine
orders of magnitude below `MAX_SAFE_INTEGER` — so precision is never at risk,
and returning strings would push string arithmetic into the pricing paths.

## Tables

**Identity** — `users`, `customers`, `employees`, `drivers`, `auth_sessions`,
`otp_codes`, `roles`, `permissions`, `role_permissions`, `user_roles`.

**Fleet** — `vehicles` (with EV telemetry columns from day one),
`driver_locations`, `zones`.

**Pricing** — `pricing_rule_sets` (versioned, immutable once published),
`fare_quotes`.

**Trips** — `trips`, `trip_status_history`, `trip_locations`,
`trip_assignments`, `scheduled_rides`.

**Negotiation** — `negotiations`, `negotiation_offers` (append-only).

**Money** — `payments`, `payment_transactions` (append-only ledger),
`webhook_events`, `refunds`, `outstanding_balances`,
`customer_payment_methods` (provider tokens only — never a card number).

**Engagement** — `loyalty_accounts`, `loyalty_transactions`, `reward_rules`,
`redemptions`, `reviews`, `saved_locations`.

**Support & safety** — `support_tickets`, `support_messages`,
`emergency_incidents`.

**Platform** — `notifications`, `push_tokens`, `payroll_periods`,
`payroll_records`, `payroll_items`, `audit_logs`, `fraud_signals`,
`idempotency_keys`, `app_settings`.

## Invariants the database enforces itself

Application discipline is the first line, not the only one.

| Guarantee | Mechanism |
| --- | --- |
| One published price list per zone | `pricing_rule_sets_single_published` partial unique index |
| A published price list is immutable | `guard_published_pricing` trigger |
| A locked fare cannot change | `guard_locked_fare` trigger |
| The quoted fare can never change | Same trigger |
| One active driver assignment per trip | `trip_assignments_one_active` partial unique index |
| One successful fare payment per trip | `payments_one_success_per_trip` partial unique index |
| A succeeded payment has been verified | `CHECK (status <> 'succeeded' OR verified_at IS NOT NULL)` |
| Webhooks process once | `UNIQUE (provider, event_id)` |
| Loyalty is awarded once per trip | `loyalty_transactions_one_earn_per_trip` |
| A refund approver is not the requester | Table `CHECK` |
| A payroll approver is not the preparer | Table `CHECK` |
| Payroll periods never overlap | `payroll_periods_range_unique` |
| Audit logs are append-only | `forbid_audit_mutation` trigger on UPDATE and DELETE |
| A scheduled trip has a pickup time; an immediate one does not | Table `CHECK` |

## Indexes that matter

Chosen from the queries that actually run hot:

```sql
-- The dispatch scan: available drivers with a recent fix
CREATE INDEX drivers_dispatch_idx ON drivers (state, last_location_at DESC) WHERE deleted_at IS NULL;

-- The dispatch queue: unassigned work, oldest first
CREATE INDEX trips_unassigned_idx ON trips (created_at)
  WHERE driver_id IS NULL AND status IN ('FARE_LOCKED','DRIVER_UNAVAILABLE');

-- The live operations board
CREATE INDEX trips_active_idx ON trips (status)
  WHERE status IN ('DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED');

-- The negotiation console
CREATE INDEX negotiations_review_queue_idx ON negotiations (created_at) WHERE status = 'AWAITING_COMPANY';

-- The offer expiry sweeper's working set
CREATE INDEX negotiation_offers_pending_idx ON negotiation_offers (expires_at) WHERE status = 'pending';
```

Partial indexes throughout: at any moment almost every trip is `COMPLETED`, and
an index over all of them to find the six that need a driver is wasted.

## Growth

`trip_locations` and `driver_locations` grow fastest — one row per driver every
10–45 seconds while on shift. Four drivers is roughly 40k rows a month, which is
nothing. **At a hundred drivers it is a million rows a month**, and that is the
point to partition by month and archive beyond 90 days. The schema needs no
change for that; only a partitioning migration.

`audit_logs` and `payment_transactions` are append-only and must never be
deleted. Archive them; do not prune them.

## Data ownership

TransportCo owns its data and can take it out: `/admin/export/:dataset` streams
CSV for trips, payments, customers and negotiations. Exports are themselves
audited — a bulk export is exactly the event worth having a record of.
