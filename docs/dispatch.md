# Dispatch

`services/api/src/domain/dispatch/scoring.ts` (pure scoring) and
`services/api/src/modules/dispatch/service.ts` (assignment, reassignment).

**The system recommends. A human assigns.** In Phase 1 a dispatcher is always
the decision-maker; the engine exists to make the right choice obvious and the
wrong one visibly wrong.

## Why not just the nearest driver

The brief calls picking the first available driver wrong, and it is. The nearest
driver is often the one who has already run nine trips today. Burning them out
costs more than the two kilometres saved, and the customer who gets an exhausted
driver at the end of a twelve-hour shift is not better served.

## Scoring

| Factor | Weight | Normalised |
| --- | --- | --- |
| Proximity | 0.45 | `1 − distance / maxRadius` |
| Workload | 0.25 | `1 − workloadScore` |
| Rating | 0.15 | `(rating − 1) / 4`; unrated drivers score 0.6 |
| Idle time | 0.15 | minutes idle / 45, capped at 1 — fair rotation |
| Vehicle readiness | 0.00 | Reserved for the EV fleet |

The score is the weighted sum, normalised to 0–100.

Workload itself is weighted toward what actually exhausts a driver:

```
0.40 × has an active trip
0.25 × scheduled trips in the next 4 hours (of 3)
0.15 × trips completed today (of 12)
0.20 × minutes on duty today (of 480)
```

Hours behind the wheel matter more than trip count, and a full upcoming schedule
matters more than a busy morning that is already finished.

## The scenario from the brief

Driver A is 2 km away, idle, low workload. Driver B is 1 km away but has run
eleven trips, has three more scheduled in the next four hours, and has been on
duty for nearly eight hours.

The engine recommends **A**, and B still appears on the board so the dispatcher
can override with full sight of the trade-off. There is a test asserting exactly
this.

## Eligibility

A driver is excluded, with the reason shown, when they are: offline, suspended,
already on a trip, without an assigned vehicle, holding an expired licence, in
conflict with a scheduled trip (±45 minutes), beyond the 25 km pickup radius, or
reporting a location fix older than two minutes.

**Stale location is disqualifying**, because an ETA computed from a position we
cannot trust is a promise to the customer we cannot keep.

Ineligible drivers are **returned, not filtered out**. A dispatcher looking at an
empty board needs to see that all four drivers are excluded and precisely why —
an unexplained blank is worse than bad news.

## Assignment

`assignDriver` runs under an advisory lock on the trip plus an optimistic
version check, so two dispatchers pressing Assign at the same moment cannot both
win.

Every assignment records the recommendation score the chosen driver had and
whether the choice was an **override**. That is what makes dispatch quality
reviewable against outcomes rather than a matter of opinion.

The previous assignment is **released, not deleted** — `trip_assignments` is the
history that answers a reassignment complaint.

## Reassignment

`markDriverUnavailable` deliberately does **not** auto-reassign. It flags the
trip, alerts operations, and offers a ranked replacement. A customer who was
told "Michael is coming" deserves a human confirming who is coming instead.

## Scheduled rides

A driver is committed at booking time so the customer knows who is coming. The
scheduler hands the trip over 30 minutes before pickup; if the committed driver
has gone offline or been suspended by then, the trip is flagged, operations is
alerted and a replacement is recommended — well before the customer is standing
on a kerb.

## Future: the EV fleet

`vehicleReadiness` is wired and weighted at zero. When TransportCo runs its own
electric vehicles the columns already exist (`battery_percent`,
`estimated_range_metres`, `charging_status`), the scorer already reads them, and
enabling the factor is a weight change:

```
range headroom = estimatedRange / (tripDistance × 2.2)
```

Trip out, trip back, and a margin.
