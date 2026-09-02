# TransportCo

A company-operated transportation platform for Rivers State, Nigeria.

TransportCo is not a ride-hailing marketplace. The company owns the vehicles,
employs the drivers, sets the fares and holds the customer relationship:

```
CUSTOMER  ->  TRANSPORTCO  ->  DRIVER
```

The customer negotiates the fare **with the company**, never with the driver.
Drivers are employees who execute assigned work; they cannot see a negotiation,
cannot change a fare, and cannot choose a trip.

Launch scope is four company vehicles and four employed drivers, on an
architecture designed to hold hundreds.

---

## What is in this repository

```
apps/
  customer-mobile/   Expo (React Native) — booking, negotiation, tracking, payment
  driver-mobile/     Expo (React Native) — availability, assigned trips, location
  admin-web/         Next.js — operations console, dispatch, negotiation, reporting

services/
  api/               Node + Express + PostgreSQL — the authoritative system
    src/domain/      Pure business logic (pricing, negotiation, dispatch, RBAC)
    src/modules/     HTTP + persistence per business area
    src/services/    Integrations (payments, maps, notifications, realtime)
    migrations/      Versioned SQL schema

packages/
  types/             Shared domain types — one definition, three applications
  validation/        Zod schemas shared by client and server
  config/            Environment loading, brand tokens, seeded defaults
  utils/             Money, geo, time and phone helpers
  ui/                React Native design system shared by both apps

docs/                Architecture and business-rule documentation
infra/               Local database and deployment assets
```

---

## Quick start

**Requirements:** Node 20+, pnpm 9+, PostgreSQL 14+.

```bash
pnpm install
cp .env.example .env            # then set DATABASE_URL and JWT_SECRET

# A local PostgreSQL, if you do not already have one:
docker compose -f infra/docker-compose.yml up -d

pnpm --filter "./packages/**" build   # shared packages compile first
pnpm db:reset                         # migrate + seed the Rivers State pilot
pnpm dev:api                          # API on :4000
pnpm dev:admin                        # console on :3000
pnpm dev:customer                     # Expo — customer app
pnpm dev:driver                       # Expo — driver app
```

`JWT_SECRET` must be at least 32 characters — generate one with
`openssl rand -base64 48`. The API refuses to start with an invalid
configuration rather than failing later at a customer's first request.

The `.env` is looked up from the working directory **upwards**, so one file at
the workspace root serves every package.

### Using Supabase (or any hosted PostgreSQL)

```bash
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres
DATABASE_SSL=true
```

Two things that will otherwise cost an hour:

- **Use the pooler host, not `db.<ref>.supabase.co`.** The direct host is
  IPv6-only; on a network without IPv6 it fails with `ENOTFOUND`/`ENETUNREACH`.
  The pooler is dual-stack.
- **Use session mode (port 5432), not transaction mode (6543)**, for migrations
  and for the API. Transaction pooling does not carry session state, and this
  codebase relies on advisory locks held for the length of a transaction.

Run the API in the **same region as the database**. The timeouts in
`src/db/pool.ts` (15s per query) assume a co-located database; a multi-query
transaction over a transatlantic link is slow enough to notice.

### Seeded accounts

Every seeded account uses the password `TransportCo123`.

| Role               | Sign in with            | Where            |
| ------------------ | ----------------------- | ---------------- |
| Super Admin        | `amaka@transportco.example`  | Admin console |
| Operations Manager | `tunde@transportco.example`  | Admin console |
| Dispatcher         | `chidi@transportco.example`  | Admin console |
| Finance            | `ngozi@transportco.example`  | Admin console |
| Customer Support   | `ibrahim@transportco.example`| Admin console |
| HR                 | `funke@transportco.example`  | Admin console |
| Driver             | `+2348040000001`             | Driver app    |
| Customer           | `+2348050000001`             | Customer app  |

In development the API returns the OTP in the registration response
(`devOtp`) so the sign-up flow can be exercised without an SMS provider. That
field is never present in production.

---

## Walking the first vertical slice

1. **Customer** — sign in, tap *Where are you going?*, choose a destination,
   tap *See my fare*. The fare comes from the server; the app never computes one.
2. **Customer** — offer less than the quoted fare. Within ~5% it is accepted
   instantly; below the floor it is declined; in between it goes to a human.
3. **Admin** — sign in as the dispatcher, open **Negotiations**, and counter.
   The customer sees the counteroffer with a live countdown.
4. **Customer** — accept. The fare locks and becomes immutable.
5. **Admin** — open **Dispatch**. The trip appears with a ranked driver
   recommendation and the reasoning behind it. Assign, or override.
6. **Driver** — sign in, go online, and the trip appears. Navigate → arrived →
   start → complete → cash collected.
7. **Customer** — rate the trip and collect loyalty points.

`scripts/smoke.cjs` does all of this against a running API and asserts 51
properties along the way — including that the negotiation floor never appears in
a customer-facing payload, that a driver payload carries no negotiation data,
and that a locked fare cannot be renegotiated:

```bash
pnpm --filter @transportco/api smoke
```

It signs in five times per run, and sign-in is limited to ten attempts per 15
minutes per IP — so running it repeatedly will hit the limiter. That is the
limiter working; restart the API to clear the in-process counters.

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs every test suite |
| `pnpm --filter @transportco/api smoke` | Walks the whole vertical slice against a running API |
| `pnpm typecheck` | Typechecks every package and application |
| `pnpm db:migrate` | Applies pending migrations |
| `pnpm db:seed` | Seeds the pilot data (development only) |
| `pnpm db:reset` | Drops, re-migrates and re-seeds (refuses in production) |
| `pnpm build` | Builds shared packages and the API |

---

## Principles this codebase holds to

- **The server is authoritative.** Fares, trip states, payment outcomes, loyalty
  points and permissions are decided server-side. The client renders.
- **Money is integers.** Every amount is kobo in a `BIGINT`. Floating point
  never touches a fare.
- **Pricing is data.** Published price lists are immutable and versioned; every
  trip stores the version that priced it.
- **Business rejections are values, not exceptions.** An offer below the floor
  is an expected outcome with a reason code, not a crash.
- **Sensitive actions are audited.** Actor, before, after, reason. The audit
  table is append-only at the database level.
- **Nothing pretends to work.** Unconfigured integrations use explicit mock
  implementations that are barred from production by configuration validation.

Further reading: [`docs/architecture.md`](docs/architecture.md) and
[`docs/business-rules.md`](docs/business-rules.md).
