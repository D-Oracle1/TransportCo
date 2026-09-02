# API reference

Base URL: `http://localhost:4000` in development.

## Conventions

Every response uses one envelope, so clients have exactly one shape to handle:

```jsonc
// Success
{ "ok": true, "data": { ... }, "requestId": "b1f2…" }

// Failure
{
  "ok": false,
  "error": {
    "code": "offer_below_floor",          // stable, machine-readable
    "message": "We cannot run this trip at ₦5,000.",
    "details": { "amountMinor": ["Amount must be greater than zero"] },
    "retryAfterSeconds": 30
  },
  "requestId": "b1f2…"
}
```

**Switch on `code`, never on `message`.** Messages are written for humans and
will change.

- Authentication: `Authorization: Bearer <accessToken>`. Access tokens last 15
  minutes; refresh tokens last 30 days and rotate on every use.
- **Money is always an integer in kobo.** `740000` is ₦7,400.
- Unsafe endpoints accept `Idempotency-Key` — send a UUID and a retry is free.
- `X-Request-Id` is echoed on every response and appears in the logs and audit
  rows for that request.

### Error codes

`validation_failed`, `unauthenticated`, `invalid_credentials`, `token_expired`,
`forbidden`, `not_found`, `conflict`, `version_conflict`, `rate_limited`,
`idempotency_key_reuse`, `account_suspended`, `phone_not_verified`,
`otp_invalid`, `otp_expired`, `otp_throttled`, `outstanding_balance`,
`invalid_state_transition`, `fare_locked`, `quote_expired`, `offer_expired`,
`negotiation_closed`, `negotiation_limit_reached`, `offer_below_floor`,
`no_driver_available`, `driver_unavailable`, `payment_failed`,
`payment_verification_failed`, `webhook_signature_invalid`,
`provider_unavailable`, `internal_error`.

---

## Authentication

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | Customer sign-up. **No card is requested.** |
| POST | `/auth/login` | Phone or email + password |
| POST | `/auth/otp/request` | Rate-limited **by phone number** |
| POST | `/auth/verify-otp` | Returns a session for `phone_verification` |
| POST | `/auth/forgot-password` | Sends a reset code |
| POST | `/auth/reset-password` | Revokes every existing session |
| POST | `/auth/refresh` | Rotates the refresh token |
| POST | `/auth/logout` | Revokes the refresh token |
| POST | `/auth/push-tokens` | Registers a device for push |
| GET | `/auth/me` | Claims for the current token |

```http
POST /auth/register
{ "fullName": "John Doe", "phone": "08012345678", "password": "Passw0rd" }

201 { "ok": true, "data": { "customerId": "…", "otpSent": true } }
```

Sign-in never distinguishes "no such account" from "wrong password" — telling an
attacker which numbers are registered is a free gift.

---

## Customer

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/customer/me` | Profile, loyalty, outstanding balance |
| PATCH | `/customer/me` | Name, email, notification preferences |
| GET/POST/DELETE | `/customer/me/locations` | Saved places |
| GET | `/customer/me/loyalty` | Balance and ledger |
| GET | `/customer/me/balances` | What is owed, and why |
| GET | `/customer/me/notifications` | In-app inbox |

---

## Booking and negotiation

```http
POST /trips/estimate
{
  "pickup":      { "latitude": 4.8156, "longitude": 7.0498, "address": "Rumuola" },
  "destination": { "latitude": 4.8087, "longitude": 7.0134, "address": "GRA Phase 2" },
  "passengers": 1
}

200 {
  "quoteId": "…",
  "fareMinor": 350000,          // ₦3,500 — computed on the server
  "distanceMetres": 12000,
  "durationSeconds": 1500,
  "expiresAt": "2026-03-10T09:15:00.000Z",
  "negotiable": true,
  "maxOffers": 2,
  "breakdown": [ { "label": "Base fare", "amountMinor": 70000 }, … ]
}
```

The response contains **no floor and no auto-accept threshold**. Those are
internal.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/trips` | Creates a trip **from a quote id** |
| GET | `/trips` | History, paginated |
| GET | `/trips/active` | The trip the app opens onto |
| GET | `/trips/:id` | Customer projection |
| GET | `/trips/:id/timeline` | Plain-language status history |
| GET | `/trips/:id/negotiation` | Customer view — floor omitted |
| POST | `/trips/:id/negotiate` | Submit an offer |
| POST | `/trips/:id/accept-fare` | Accept; locks the fare |
| GET | `/trips/:id/cancellation-preview` | What cancelling would cost |
| POST | `/trips/:id/cancel` | Cancel |
| POST | `/trips/:id/review` | Rate the driver |

```http
POST /trips/{id}/negotiate
{ "amountMinor": 700000 }

200 {
  "outcome": "countered",        // accepted | rejected | countered | under_review | limit_reached
  "message": "We can do ₦7,500 for this trip.",
  "counterAmountMinor": 750000,
  "offersRemaining": 1,
  "expiresAt": "2026-03-10T09:05:00.000Z",
  "expiresInSeconds": 300
}
```

---

## Driver

Every route is scoped to the driver in the token. There is **no** fare editing,
**no** negotiation and **no** trip selection.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/drivers/me/dashboard` | State, today's totals, active and scheduled trips |
| POST | `/drivers/me/state` | `OFFLINE` / `ONLINE` / `AVAILABLE` / `ON_BREAK` |
| POST | `/drivers/me/location` | Single fix |
| POST | `/drivers/me/location/batch` | Offline queue flush, up to 200 fixes |
| GET | `/drivers/me/trips` | History |
| GET | `/drivers/me/trips/:id` | Trip; customer phone masked, fare read-only |
| POST | `/drivers/me/trips/:id/actions` | `start_pickup`, `arrived`, `start_trip`, `complete_trip`, `report_no_show` |
| POST | `/drivers/me/trips/:id/cash` | Cash collected — must equal the locked fare |

A driver cannot go offline mid-trip, and cannot mark "arrived" from more than
250 m away.

---

## Payments

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/payments/initialize` | **Amount is read from the trip, never from the client** |
| POST | `/payments/verify` | Server-side verification |
| GET | `/payments` | Customer's payment history |
| POST | `/payments/webhook/:provider` | Raw body, signature-verified, idempotent |

The webhook route is mounted **before** the JSON body parser: signatures are
computed over raw bytes, and re-serialising JSON invalidates them.

---

## Support and safety

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/support/tickets` | Safety reports are flagged urgent automatically |
| GET | `/support/tickets` | Own tickets; internal agent notes excluded |
| POST | `/support/tickets/:id/messages` | Reply |
| POST | `/support/sos` | Writes the incident first, then notifies |

---

## Admin

Every route names the permission it needs.

**Operations** — `/admin/dashboard`, `/admin/live`, `/admin/trips`,
`/admin/trips/:id`, `/admin/trips/:id/cancel`, `/admin/dispatch/board`,
`/admin/dispatch/trips/:id/recommendations`, `/admin/dispatch/trips/:id/assign`,
`/admin/dispatch/trips/:id/driver-unavailable`, `/admin/negotiations/queue`,
`/admin/negotiations/:id`, `/admin/negotiations/:id/respond`,
`/admin/support/tickets`, `/admin/emergency/incidents`.

**People** — `/admin/customers`, `/admin/customers/:id`,
`/admin/customers/:id/suspend`, `/admin/loyalty/adjust`, `/admin/drivers`,
`/admin/drivers/:id`, `/admin/roles`, `/admin/users/:id/roles`.

**Business** — `/admin/pricing`, `/admin/pricing/:id/publish`,
`/admin/payments`, `/admin/payments/cash-reconciliation`,
`/admin/payments/refunds`, `/admin/balances/:id/write-off`,
`/admin/payroll/periods`, `/admin/payroll/periods/:id/approve`,
`/admin/reports/kpis`, `/admin/audit-logs`, `/admin/fraud-signals`,
`/admin/export/:dataset`.

```http
GET /admin/dispatch/trips/{id}/recommendations

200 {
  "recommended": { "driverId": "…", "fullName": "Michael Okoro", "score": 82.4, … },
  "candidates": [
    {
      "fullName": "Michael Okoro",
      "score": 82.4,
      "eligible": true,
      "factors": [
        { "code": "proximity", "detail": "2.4 km away",          "contribution": 0.41 },
        { "code": "workload",  "detail": "2 trips today",        "contribution": 0.22 },
        …
      ]
    },
    { "fullName": "Emeka Duru", "eligible": false, "exclusionReasons": ["stale_location"] }
  ]
}
```

Ineligible drivers are returned **with their reasons**: a dispatcher looking at
an empty board needs to know why, not just that.

---

## Realtime

Socket.IO at `/realtime`; authenticate with `auth: { token }`.

Events: `trip.status_changed`, `trip.driver_assigned`, `trip.driver_location`,
`negotiation.offer_created`, `negotiation.offer_resolved`,
`negotiation.expired`, `driver.state_changed`, `driver.location`,
`emergency.raised`, `notification.created`.

Subscribe to a trip with `socket.emit('trip:subscribe', tripId, ack)`; the
server checks participation before joining you. Every envelope carries a
per-room `sequence` so a client can detect a gap and refetch.

---

## Rate limits

| Bucket | Limit | Keyed by |
| --- | --- | --- |
| Login / password reset | 10 / 15 min | IP |
| OTP requests | 5 / 15 min | **phone number** (each SMS costs money) |
| Fare estimates | 60 / min | user |
| Negotiation offers | 20 / min | user |
| Location pings | 120 / min | driver |
| Support tickets | 10 / hour | user |
| SOS | 5 / 10 min | user |
| Everything else | 120 / min | user |
