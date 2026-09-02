# Security

## Threat model

A transport operator holds the home and work addresses of everyone who has ever
booked, live locations of people in transit, and money. The attackers worth
designing against are:

1. **Someone enumerating customers** — testing phone numbers to find accounts,
   or walking trip ids to read strangers' addresses.
2. **A stolen device or token** — a phone left in a taxi, an XSS bug in the
   console.
3. **A dishonest insider** — a refund to a friend, a fare override, a payroll
   adjustment.
4. **A dishonest driver** — a spoofed GPS trail, a trip marked complete that
   never moved, cash that never reached the office.
5. **A hostile client** — a modified app posting its own fare or trip state.

## Authentication

- Passwords: bcrypt, 12 rounds.
- Access tokens: 15 minutes, HS256 with a **pinned algorithm** — a token never
  chooses its own.
- Refresh tokens: opaque, 30 days, **stored only as a SHA-256 hash**. A database
  dump yields no usable sessions. They rotate on every use, so a stolen token is
  usable at most once before the theft becomes visible.
- Five failed sign-ins lock an account for fifteen minutes.
- Sign-in never distinguishes "no such account" from "wrong password", and hashes
  a dummy value when no user is found so response timing does not leak either.
- OTPs are stored hashed, attempt-limited, and expire in five minutes. OTP
  requests are rate-limited **by phone number** — each SMS costs money, and
  enumeration is the abuse case.
- A password reset revokes every existing session. If the reset was triggered by
  a compromise, leaving old sessions alive defeats the point.

### Token storage

| Client | Where | Why |
| --- | --- | --- |
| Mobile | `expo-secure-store` (Keychain / Keystore) | AsyncStorage is plain text on a rooted device |
| Admin console | **httpOnly cookies** | An XSS bug must not walk away with an operations session |

The console never sees a token in JavaScript. Client components call
`/api/proxy/*`, a Next.js route handler that reattaches the token server-side —
and that proxy has an allowlist, because an open proxy carrying a privileged
token would be a gift to anyone who found it.

## Authorisation

Code checks **permissions**, never role names. Roles are data; a new role is a
row, not a deploy.

Every non-public route declares its permission. Ownership is checked separately:
a customer may only read their own trips, a driver only their own assignments.
This is the guard that stops `/trips/{someone-elses-id}` from being an
information leak — the most common way a transport app exposes strangers' home
addresses.

PII is graded. A dispatcher sees a customer's name; only `customer:read_pii`
sees the phone number. Salary is `payroll:read` only, stripped from the driver
record for everyone else.

### Separation of duty

Enforced by the database, not only by convention:

- A refund approver cannot be the requester (`CHECK`).
- A payroll approver cannot be the preparer (`CHECK` and a route check).
- Nobody can change their own roles (route check).
- `payroll:write` and `payroll:approve` are held by different seeded roles.
- Changing a user's roles revokes their sessions, so a removed permission takes
  effect immediately rather than whenever their token happens to expire.

## What the client is never trusted with

Fares, trip states, payment outcomes, loyalty points, driver assignment, roles
and permissions. Every one is decided server-side. The client posts a quote id
and an intent; the server decides what that means.

## Request security

- **Validation**: every body, query and param is parsed by a Zod schema, and the
  parsed value replaces the raw input, so a handler cannot accidentally read an
  unvalidated field.
- **Rate limiting**: tight buckets on the endpoints that cost money or enable
  enumeration (see `docs/api.md`).
- **Idempotency**: unsafe endpoints accept `Idempotency-Key`; the same key with a
  different body is rejected rather than silently replayed.
- **CORS**: an explicit origin allowlist; wildcards are refused in production by
  configuration validation.
- **Helmet**: strict CSP, `frame-ancestors: none`, HSTS in production.
- **Body limits**: 256 KB for JSON, 1 MB for webhooks.
- **Statement timeouts**: 15 seconds, so a hung query cannot hold a connection.

## Secrets

- Validated at boot; the process refuses to start on an invalid configuration.
- Production **refuses to boot** with a mock payment provider, a mock maps
  provider, a placeholder JWT secret, or a wildcard CORS origin.
- Logs redact tokens, passwords, OTPs, provider signatures and provider keys.
- `describeConfig()` returns a redacted snapshot for the boot log.
- `.env` is gitignored; `.env.example` documents every variable.

## Audit

Every sensitive action writes an `audit_logs` row: actor, role, action,
resource, previous value, new value, reason, IP, user agent, request id. The
table is append-only **at the database level** — a trigger refuses UPDATE and
DELETE.

Audited actions include fare adjustments and locks, pricing publication,
negotiation responses and floor overrides, driver assignment and reassignment,
forced state changes, refunds, balance write-offs, customer suspensions, loyalty
adjustments, payroll approval, role changes and data exports.

## Fraud signals

Rules and anomaly indicators, reviewed by a human — not a model. At four
vehicles there is no training data, and a score nobody can explain is useless
when you have to confront a specific driver about a specific trip.

- **Driver**: GPS jumps above 200 km/h (the fix is rejected, not stored as
  truth), completion without movement, route deviation beyond 1.6×.
- **Customer**: repeated cancellations, duplicate sign-up devices.
- **Administrator**: refund velocity, fare-override velocity, self-approval.

## Known gaps for the pilot

Stated plainly rather than left to be discovered:

- Rate limiting and the scheduler are in-process. Two API instances need Redis
  and either a leader election or an external scheduler.
- SMS, email and WhatsApp adapters log rather than send until credentials exist.
  They report `delivered: false`, so nothing pretends to have been sent.
- No 2FA for staff console accounts. It belongs before the fleet grows.
- Location history is retained indefinitely; a retention policy should land
  before volumes make it a liability.
