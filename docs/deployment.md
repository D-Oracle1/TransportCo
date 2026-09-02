# Deployment

## Environments

| Environment | Purpose | Payments | Maps |
| --- | --- | --- | --- |
| development | Local | `mock` | `mock` |
| test | CI | `mock` | `mock` |
| production | Live | `paystack` / `flutterwave` | `google` |

Production **refuses to boot** with a mock provider, a placeholder JWT secret or
a wildcard CORS origin. A misconfigured deployment should fail on the deploy,
not at a customer's first transaction.

## Prerequisites

- Node 20 LTS or newer
- PostgreSQL 14+ (managed, with automated backups and point-in-time recovery)
- TLS terminated at the load balancer
- Paystack and/or Flutterwave live keys, with webhook URLs registered
- A Google Maps key: server-side, IP-restricted, Directions + Geocoding only.
  Client keys are separate and platform-restricted.

## API

```bash
pnpm install --frozen-lockfile
pnpm --filter "./packages/**" build
pnpm --filter @transportco/api build
pnpm --filter @transportco/api db:migrate
node services/api/dist/index.js
```

Behind a load balancer:

- `trust proxy` is on, so `X-Forwarded-For` drives rate limiting and audit rows.
- `keepAliveTimeout` is 65s and `headersTimeout` 70s — both **above** a typical
  60s LB idle timeout, which avoids the classic 502-on-reused-connection.
- `/health` is liveness; `/health/ready` checks the database and is what the LB
  should poll.
- SIGTERM stops the scheduler, closes the socket server, drains in-flight
  requests, then closes the pool, with a 15-second backstop. A trip transaction
  cut in half by a deploy is a day of reconciliation.

**Run exactly one API instance until the scheduler and rate limiter move to
Redis.** Two instances would run every background job twice — double reminders,
double dispatch attempts. This is the first thing to change as the fleet grows.

## Admin console

```bash
pnpm --filter @transportco/admin-web build
pnpm --filter @transportco/admin-web start
```

Needs `NEXT_PUBLIC_API_BASE_URL`. Deploys cleanly to Vercel or any Node host;
every console page is dynamic, so nothing is prerendered with stale operational
data.

## Mobile apps

```bash
npx eas build --platform android --profile production
npx eas build --platform ios --profile production
npx eas submit --platform android
```

`EXPO_PUBLIC_*` variables are embedded at build time and are **public** — only
platform-restricted client keys belong there. Never a server key.

## Database

```bash
pnpm db:migrate                                   # apply
pnpm --filter @transportco/api db:migrate status  # inspect
```

Migrations run in filename order, each in a transaction, checksummed. An applied
migration is immutable; changing one is refused. Roll forward with a new
migration rather than editing history.

`db:reset` and the seed refuse to run in production.

Back up before every deploy that includes a migration, and rehearse the restore
— an untested backup is a hope, not a backup.

## Webhooks

Register with the providers:

```
POST https://api.transportco.example/payments/webhook/paystack
POST https://api.transportco.example/payments/webhook/flutterwave
```

Both must be publicly reachable and must **not** sit behind authentication —
the signature is the authentication. Set `PAYSTACK_WEBHOOK_SECRET` and
`FLUTTERWAVE_WEBHOOK_HASH` before going live, or every event is rejected.

## Monitoring

Structured JSON logs (pino) with a request id on every line, ready for any
aggregator. Watch, at minimum:

| Signal | Why |
| --- | --- |
| `/health/ready` failures | Database reachability |
| 5xx rate | Obvious |
| `payment_verification_failed` | Money that did not settle |
| Unprocessed `webhook_events` | Provider or handler trouble |
| Trips in `FARE_LOCKED` over 10 minutes | Dispatch is not keeping up |
| Open `emergency_incidents` | Safety, above everything |
| Slow-query warnings (>500 ms) | The live map degrades first |
| Open critical `fraud_signals` | Insider and driver risk |

## Rollback

1. Revert the application deployment (migrations are additive and backward
   compatible within a release, so the previous build runs against the new
   schema).
2. Only restore the database if a migration corrupted data — and expect to lose
   everything since the snapshot.
3. Never edit an applied migration to "fix" it; write a new one.

## Before the pilot goes live

- [ ] `JWT_SECRET` generated fresh; not the placeholder
- [ ] Live payment keys and webhook secrets set and tested end to end
- [ ] Google Maps key restricted by IP and API
- [ ] `CORS_ALLOWED_ORIGINS` set to the real console origin only
- [ ] Database backups running, and a restore rehearsed
- [ ] Seeded staff passwords changed
- [ ] `OPS_EMERGENCY_HOTLINE` set to a number a human actually answers
- [ ] Pricing reviewed and published by someone with the authority to price
- [ ] Push credentials configured; SMS provider connected
- [ ] Alerting wired for the signals above
