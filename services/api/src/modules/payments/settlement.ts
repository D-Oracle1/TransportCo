import type { PoolClient } from 'pg';
import type { PaymentPurpose } from '@transportco/types';
import { formatMoney } from '@transportco/utils';
import { queryOne } from '../../db/pool';
import { computeEarnedPoints, pointsExpiryDate, tierForLifetimePoints } from '../../domain/loyalty/rules';
import { getPricingRuleSetById } from '../pricing/repository';
import { transitionTrip, type TripRow } from '../trips/repository';
import { userIdForCustomer } from '../trips/service';
import { notify } from '../../services/notifications';
import { logger } from '../../lib/logger';

/**
 * SETTLEMENT — what happens after money actually arrives.
 *
 * Called from inside the payment transaction, so either all of it happens or
 * none of it does: the trip advances, the loyalty ledger is written, and any
 * outstanding balance is cleared as one atomic act. A customer whose payment
 * succeeded but whose points went missing is a support ticket that costs more
 * than the points.
 */

export interface SettlementInput {
  paymentId: string;
  tripId: string | null;
  customerId: string;
  purpose: PaymentPurpose;
  amountMinor: number;
}

export async function onPaymentSucceeded(client: PoolClient, input: SettlementInput): Promise<void> {
  if (input.purpose === 'trip_fare' && input.tripId) {
    await settleTripFare(client, input);
    return;
  }

  // Cancellation fees, no-show fees and balance top-ups all settle debt.
  await settleOutstandingBalance(client, input);
}

async function settleTripFare(client: PoolClient, input: SettlementInput): Promise<void> {
  const trip = await queryOne<TripRow>('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [input.tripId], client);
  if (!trip) return;

  await client.query(`UPDATE trips SET payment_status = 'paid' WHERE id = $1`, [trip.id]);

  const refreshed = { ...trip, payment_status: 'paid' as const };

  // TRIP_COMPLETED -> PAYMENT_PENDING may already have happened; from either
  // point the settled payment moves the trip forward.
  if (['TRIP_COMPLETED', 'PAYMENT_PENDING', 'PAYMENT_FAILED'].includes(trip.status)) {
    const paid = await transitionTrip(client, refreshed, 'PAYMENT_COMPLETED', 'system', {
      reason: 'Payment verified',
      metadata: { paymentId: input.paymentId },
    });

    await transitionTrip(client, paid, 'REVIEW_PENDING', 'system', {
      reason: 'Awaiting customer rating',
    });
  }

  await awardLoyaltyPoints(client, {
    customerId: input.customerId,
    tripId: trip.id,
    amountMinor: input.amountMinor,
    pricingRuleSetId: trip.pricing_rule_set_id,
  });

  const userId = await userIdForCustomer(input.customerId, client);
  await notify({
    userId,
    event: 'customer.payment_received',
    data: { amount: formatMoney(input.amountMinor), reference: trip.reference },
    dedupeKey: `payment:${input.paymentId}:received`,
  }).catch(() => undefined);
}

async function settleOutstandingBalance(client: PoolClient, input: SettlementInput): Promise<void> {
  let remaining = input.amountMinor;

  // Oldest debt first — the fair order, and the one a customer expects when
  // they see their balance go down.
  const balances = await client.query<{ id: string; amount_minor: number; settled_amount_minor: number }>(
    `SELECT id, amount_minor, settled_amount_minor
       FROM outstanding_balances
      WHERE customer_id = $1 AND status IN ('outstanding','partially_settled')
      ORDER BY created_at ASC
      FOR UPDATE`,
    [input.customerId],
  );

  for (const balance of balances.rows) {
    if (remaining <= 0) break;

    const due = balance.amount_minor - balance.settled_amount_minor;
    const applied = Math.min(due, remaining);
    const settledTotal = balance.settled_amount_minor + applied;

    await client.query(
      `UPDATE outstanding_balances
          SET settled_amount_minor = $2,
              status = CASE WHEN $2 >= amount_minor THEN 'settled' ELSE 'partially_settled' END,
              settled_at = CASE WHEN $2 >= amount_minor THEN now() ELSE settled_at END
        WHERE id = $1`,
      [balance.id, settledTotal],
    );

    remaining -= applied;
  }

  const stillOwing = await queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(amount_minor - settled_amount_minor), 0)::bigint AS total
       FROM outstanding_balances
      WHERE customer_id = $1 AND status IN ('outstanding','partially_settled')`,
    [input.customerId],
    client,
  );

  await client.query('UPDATE customers SET has_outstanding_balance = $2 WHERE id = $1', [
    input.customerId,
    Number(stillOwing?.total ?? 0) > 0,
  ]);
}

/**
 * Loyalty accrual.
 *
 * Points are earned on the amount PAID, not the amount quoted — rewarding a
 * customer for the discount they negotiated would pay for the same trip twice.
 * The unique index on (trip_id) where type = 'earn' makes a retried settlement
 * a no-op rather than a double award.
 */
async function awardLoyaltyPoints(
  client: PoolClient,
  args: { customerId: string; tripId: string; amountMinor: number; pricingRuleSetId: string },
): Promise<void> {
  try {
    const rules = await getPricingRuleSetById(args.pricingRuleSetId);
    const points = computeEarnedPoints(args.amountMinor, rules.loyalty);
    if (points <= 0) return;

    const account = await queryOne<{ id: string; balance_points: number; lifetime_earned_points: number }>(
      `INSERT INTO loyalty_accounts (customer_id) VALUES ($1)
       ON CONFLICT (customer_id) DO UPDATE SET updated_at = now()
       RETURNING id, balance_points, lifetime_earned_points`,
      [args.customerId],
      client,
    );

    const balanceAfter = account!.balance_points + points;
    const lifetime = account!.lifetime_earned_points + points;

    const transaction = await queryOne<{ id: string }>(
      `INSERT INTO loyalty_transactions (
         account_id, customer_id, type, points, balance_after, trip_id, source_amount_minor, reason, expires_at
       ) VALUES ($1, $2, 'earn', $3, $4, $5, $6, $7, $8)
       ON CONFLICT (trip_id) WHERE type = 'earn' AND trip_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        account!.id,
        args.customerId,
        points,
        balanceAfter,
        args.tripId,
        args.amountMinor,
        `Earned on trip payment of ${formatMoney(args.amountMinor)}`,
        pointsExpiryDate(new Date(), rules.loyalty),
      ],
      client,
    );

    if (!transaction) return; // already awarded for this trip

    await client.query(
      `UPDATE loyalty_accounts
          SET balance_points = $2, lifetime_earned_points = $3, tier = $4
        WHERE id = $1`,
      [account!.id, balanceAfter, lifetime, tierForLifetimePoints(lifetime)],
    );

    const userId = await userIdForCustomer(args.customerId, client);
    await notify({
      userId,
      event: 'customer.loyalty_earned',
      data: { points },
      dedupeKey: `trip:${args.tripId}:loyalty`,
    }).catch(() => undefined);
  } catch (error) {
    // Loyalty is a benefit, not a precondition of payment. Log loudly, but do
    // not roll back a successful payment because points failed.
    logger.error({ err: error, tripId: args.tripId }, 'Loyalty accrual failed');
  }
}
