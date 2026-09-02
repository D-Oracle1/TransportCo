# Contributing

## Before you start

Read `docs/business-rules.md`. Most of this codebase encodes a decision someone
made about how the business works; changing the code without knowing the rule is
how a fare stops being defensible.

## The rules that are not negotiable

1. **The server decides.** Fares, trip states, payment outcomes, loyalty points
   and permissions are computed server-side. If you find yourself computing one
   in a client, stop.
2. **Money is an integer in kobo.** Never a float, never a string in arithmetic.
   Use the helpers in `@transportco/utils`.
3. **The domain layer stays pure.** No database, no clock, no network in
   `services/api/src/domain`. If a rule needs data, the caller fetches it.
4. **Business rejections are values.** An offer below the floor returns a
   decision with a reason code; it does not throw.
5. **Sensitive actions are audited.** Actor, before, after, reason — inside the
   same transaction as the change.
6. **Nothing pretends to work.** A mock reports that it is a mock and is barred
   from production by configuration validation.
7. **The floor never leaks.** Anything a customer can see must not reveal the
   lowest acceptable fare.

## Adding a business rule

1. Put the logic in `domain/`, as a pure function.
2. Test it there — the domain suite is the one that must never go red.
3. Wire it in `modules/`, inside a transaction if more than one row changes.
4. Expose it in `routes/`, with an explicit permission.
5. Update `docs/business-rules.md`.

## Changing pricing

Never edit a published rule set. Create a draft, publish it, and let the old one
archive. The database will refuse anything else.

## Adding a migration

New file, next number, in `services/api/migrations`. Never edit an applied
migration — the checksum check will refuse it, and it is refusing it for a good
reason.

## Before opening a pull request

```bash
pnpm typecheck
pnpm test
```

Both must be clean. If you touched pricing, negotiation, dispatch or the state
machine, expect to have added tests.
