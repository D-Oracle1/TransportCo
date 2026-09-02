# Pricing engine

`services/api/src/domain/pricing/engine.ts` — pure, deterministic, no clock, no
database, no network. The same inputs and the same rule set always produce the
same fare. That is what makes a completed trip re-derivable years later and what
makes the file cheap to test exhaustively.

## Order of operations

```
1. Additive          base + distance + duration + extra passengers
2. Multiplicative    peak, night, weekend, holiday, demand, scheduled
                     — each recorded as the DELTA it contributed
3. Floor and ceiling minimum fare, then maximum fare
4. Rounding          up to a clean increment (₦50)
```

Written down because the order changes the answer. Applying the minimum before
surcharges would surcharge the minimum; rounding before the floor could round
below it.

### Surcharges are additive, not compounding

A peak (+20%) night (+15%) trip is **+35%** of the additive subtotal, not
1.20 × 1.15 = +38%.

Compounding is how a fare quietly becomes indefensible. On a Saturday night in
December three multiplied surcharges produce a number no operator can justify to
a customer at the roadside — and a customer who feels ambushed by a price does
not come back. Every surcharge appears in the breakdown as the naira amount it
added, so the receipt always sums to the total.

## Configuration, not code

Every number lives in `pricing_rule_sets`, edited through the admin console.
Nothing is hardcoded in a screen. Launch defaults for Rivers State:

| Setting | Default |
| --- | --- |
| Base fare | ₦700 |
| Per kilometre | ₦180 |
| Per minute | ₦25 |
| Minimum fare | ₦1,200 |
| Rounding | up to ₦50 |
| Long distance | ₦140/km beyond 30 km |
| Extra passenger | ₦200 beyond 3 |
| Peak | ×1.2, weekdays 06:30–09:30 and 16:30–19:30 |
| Night | ×1.15, 22:00–05:00 (wraps midnight) |
| Weekend | ×1.1, Saturday and Sunday |
| Public holiday | ×1.25, on configured dates |
| Scheduled ride | ×1.05 |
| Demand | ×1.0, capped at ×1.8 |

A 12 km, 25-minute off-peak trip: ₦700 + ₦2,160 + ₦625 = ₦3,485 → **₦3,500**.

## Versioning

Publishing a change creates a **new version**; the previous one is archived with
an `effective_to`. A published rule set is immutable — a trigger refuses to
change one — and exactly one may be published per zone, enforced by a partial
unique index. Two live price lists would silently produce two different fares
for the same trip.

Every quote and trip stores `pricing_rule_set_id` and `pricing_version`, and
cancellation fees for a trip are read from **that** version, so a customer is
never charged under a policy published after they booked.

`pricing:write` (draft) and `pricing:publish` are separate permissions: writing a
draft is analysis, publishing changes what every customer pays from the next
quote onward.

## Local time

Windows are evaluated in West Africa Time via `localParts()`. A server in
another region would otherwise price Port Harcourt evenings wrong. Windows may
wrap midnight, which `isMinuteInWindow` handles explicitly.

## Negotiation bounds

The engine derives two internal thresholds from every quote:

```
floor        = quote × (1 − maxDiscountPercent/100)      // never below the minimum fare
autoAccept   = quote × (1 − autoAcceptDiscountPercent/100)
```

Both are **internal**. Neither is ever serialised to a customer response —
knowing the floor turns every negotiation into a single move to it.

The floor additionally never dips below the minimum fare: a discount that takes
a trip below the price at which dispatching a company vehicle is worthwhile is
not a discount, it is a loss.

## Contribution margin

```
revenue − refunds
        − fuel/energy (per km)
        − driver variable cost (per trip)
        − operating overhead (per trip)
        − payment provider fees (percent + flat, capped)
= contribution margin
```

This is what tells management whether negotiation is winning volume or giving
away money. It appears per trip and aggregated in `/admin/reports/kpis`,
directly beside total discount given.

## Testing

25 tests in `engine.test.ts` cover the additive components, each surcharge
window (including the midnight wrap), the additive-composition property, the
floor and ceiling, rounding, long distance, extra passengers, the demand cap,
determinism, integer-only output, and input rejection.

Fixtures are built from the **real seeded defaults**, so a test failing after
someone edits launch pricing is a signal worth reading rather than noise to
silence.
