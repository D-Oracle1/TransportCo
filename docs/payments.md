# Payments

`services/api/src/services/payments/` — a `PaymentService` with provider
adapters. Trip logic never imports Paystack or Flutterwave.

## Adapters

| Adapter | Notes |
| --- | --- |
| `PaystackAdapter` | Denominates in **kobo** — matches our representation exactly |
| `FlutterwaveAdapter` | Denominates in **naira** — converted at the boundary |
| `CashPaymentHandler` | Confirmed by the assigned driver, not by a provider |
| `MockPaymentAdapter` | Development only; **refuses to construct in production** |

The Flutterwave conversion lives in two named helpers rather than being inlined
at each call site, because that boundary is the single most likely place for a
100× error.

Adding a provider — or switching because one has a bad week, which happens — is
a new file plus a config value, not a change to the booking flow.

## The three rules

**1. A payment succeeds only on evidence.** Server-side verification or a
signature-verified webhook. Not a client redirect, not a client claim. A
database `CHECK` enforces that a succeeded payment carries a `verified_at`.

**2. The amount must match.** A provider dashboard showing "successful" for the
wrong amount is a discrepancy for Finance, not a settled trip. A mismatch fails
the payment and alerts.

**3. Webhooks are idempotent.** Providers redeliver; that is normal, not
exceptional. The provider event id is the primary key of `webhook_events`, so a
second delivery inserts nothing, and `payment_transactions.idempotency_key` is
unique underneath that.

## Raw bodies

The webhook router is mounted in `app.ts` **before** the JSON body parser.
Signatures are computed over raw bytes; parsing and re-serialising JSON changes
them and every check would fail. This ordering is load-bearing and commented in
place.

Paystack signs with HMAC-SHA512 over the body. Flutterwave sends a shared secret
header. Both are compared in constant time — a timing oracle on a shared secret
is a slower but perfectly real attack.

## Settlement

`modules/payments/settlement.ts` runs inside the payment transaction, so the
trip advancing, the loyalty ledger and any outstanding balance all commit
together. A customer whose payment succeeded but whose points went missing is a
support ticket that costs more than the points.

Loyalty accrual is the one deliberate exception: a failure logs loudly but does
not roll back a successful payment. Points are a benefit, not a precondition of
taking money.

## Cash

Cash is a first-class payment with a lifecycle, not the absence of one.

- **The amount must equal the locked fare exactly.** A driver cannot record "the
  customer only had ₦5,000" as a completed payment; a shortfall is an operations
  decision.
- Only the **assigned** driver can confirm collection.
- Collection is recorded against them by name, and
  `/admin/payments/cash-reconciliation` shows Finance what each driver owes the
  office at the end of a shift.

## Bank transfer

Verified through the provider, never on the customer's word. The provider issues
dynamic account details; the webhook — or the reconciliation job — confirms.

## Reconciliation

Providers do miss webhooks. Every five minutes the scheduler verifies payments
that have sat pending for more than ten minutes, because the customer's side of
that limbo is a trip that will not close.

## Refunds

Requested with a reason (audited), and the database refuses a row where the
approver is the requester. Refund velocity per administrator is monitored as an
insider-risk signal. Cash refunds are handed over in person and settled by
Finance; only card and transfer payments go back through a provider.

## Outstanding balances

Because no card is taken at sign-up, an unpaid cancellation or no-show fee
becomes an `outstanding_balance` — a visible debt the customer settles
deliberately. Payments against it are applied oldest-debt-first, which is both
fair and what a customer expects when they watch the number go down.

## What is never stored

Card numbers. Ever. `customer_payment_methods` holds a provider token, the last
four digits, a brand and an expiry — nothing that could charge a card anywhere
except through the provider that issued the token.
