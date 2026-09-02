import { OPERATIONS_DEFAULTS } from '@transportco/config';
import { query, queryOne } from '../db/pool';
import { logger } from '../lib/logger';
import { expireStaleOffers } from '../modules/negotiation/service';
import { autoAssignBest, markDriverUnavailable } from '../modules/dispatch/service';
import { purgeExpiredIdempotencyKeys } from '../middleware/idempotency';
import { notify } from '../services/notifications';
import { userIdForCustomer, userIdForDriver } from '../modules/trips/service';
import { verifyPayment } from '../services/payments';

/**
 * BACKGROUND WORK.
 *
 * An in-process interval scheduler, which is the honest shape for a single
 * pilot instance. Each job is idempotent and takes a database-level guard, so
 * moving to a proper queue later is a change of trigger, not of logic.
 *
 * Every job here exists because a customer would otherwise be left waiting:
 * offers that never expire, scheduled rides nobody dispatches, payments a
 * provider never told us about.
 */

type Job = { name: string; intervalMs: number; run: () => Promise<void> };

let timers: NodeJS.Timeout[] = [];

/**
 * Server-authoritative offer expiry. A client's countdown reaching zero is
 * cosmetic; THIS is what actually closes the offer.
 */
async function expireOffersJob(): Promise<void> {
  await expireStaleOffers();
}

/**
 * Quotes that were never turned into a trip.
 */
async function expireQuotesJob(): Promise<void> {
  const rows = await query<{ id: string }>(
    `UPDATE fare_quotes SET status = 'expired'
      WHERE status = 'active' AND expires_at <= now()
      RETURNING id`,
  );
  if (rows.length > 0) logger.debug({ count: rows.length }, 'Expired stale fare quotes');
}

/**
 * Hand scheduled rides to their drivers at the right moment, and — the part
 * that matters operationally — notice when a committed driver has gone offline
 * before the pickup.
 */
async function scheduledRidesJob(): Promise<void> {
  const due = await query<{
    id: string;
    trip_id: string;
    assigned_driver_id: string | null;
    driver_state: string | null;
    scheduled_pickup_at: Date;
  }>(
    `SELECT s.id, s.trip_id, s.assigned_driver_id, d.state AS driver_state, s.scheduled_pickup_at
       FROM scheduled_rides s
       LEFT JOIN drivers d ON d.id = s.assigned_driver_id
      WHERE s.status IN ('scheduled','reassigned','driver_unavailable')
        AND s.dispatch_due_at <= now()
        AND s.dispatched_at IS NULL
      ORDER BY s.scheduled_pickup_at ASC
      LIMIT 20`,
  );

  for (const ride of due) {
    try {
      // No driver, or the committed one has gone offline or been suspended:
      // operations needs to know now, not at the pickup time.
      const driverUsable =
        ride.assigned_driver_id !== null &&
        ride.driver_state !== null &&
        !['OFFLINE', 'SUSPENDED'].includes(ride.driver_state);

      if (!driverUsable) {
        if (ride.assigned_driver_id) {
          await markDriverUnavailable({
            tripId: ride.trip_id,
            reason: 'Assigned driver is not available for the scheduled pickup',
            actorUserId: null,
          });
        }

        const replacement = await autoAssignBest(ride.trip_id, 'driver_unavailable');
        if (!replacement) {
          logger.error({ tripId: ride.trip_id }, 'No driver available for a scheduled ride');
          continue;
        }
      }

      await query(
        `UPDATE scheduled_rides SET status = 'dispatched', dispatched_at = now() WHERE id = $1`,
        [ride.id],
      );
    } catch (error) {
      logger.error({ err: error, scheduledRideId: ride.id }, 'Scheduled ride dispatch failed');
    }
  }
}

/** Reminders to both sides before a scheduled pickup. */
async function scheduledRemindersJob(): Promise<void> {
  const upcoming = await query<{
    id: string;
    trip_id: string;
    customer_id: string;
    assigned_driver_id: string | null;
    scheduled_pickup_at: Date;
  }>(
    `SELECT id, trip_id, customer_id, assigned_driver_id, scheduled_pickup_at
       FROM scheduled_rides
      WHERE status IN ('scheduled','reassigned','dispatched')
        AND reminder_sent_at IS NULL
        AND scheduled_pickup_at BETWEEN now() AND now() + ($1 || ' seconds')::interval
      LIMIT 50`,
    [OPERATIONS_DEFAULTS.scheduledReminderLeadSeconds],
  );

  for (const ride of upcoming) {
    const time = ride.scheduled_pickup_at.toLocaleTimeString('en-NG', {
      hour: '2-digit',
      minute: '2-digit',
    });

    try {
      await notify({
        userId: await userIdForCustomer(ride.customer_id),
        event: 'customer.scheduled_reminder',
        data: { time, driverName: 'Your driver' },
        dedupeKey: `scheduled:${ride.id}:customer_reminder`,
      });

      if (ride.assigned_driver_id) {
        await notify({
          userId: await userIdForDriver(ride.assigned_driver_id),
          event: 'driver.scheduled_reminder',
          data: { time, customerName: 'your customer' },
          dedupeKey: `scheduled:${ride.id}:driver_reminder`,
        });
      }

      await query('UPDATE scheduled_rides SET reminder_sent_at = now() WHERE id = $1', [ride.id]);
    } catch (error) {
      logger.warn({ err: error, scheduledRideId: ride.id }, 'Scheduled reminder failed');
    }
  }
}

/**
 * Reconciliation.
 *
 * Payment providers do miss webhooks. A pending payment older than ten minutes
 * gets an explicit verification call rather than sitting in limbo, because the
 * customer's side of that limbo is a trip that will not close.
 */
async function reconcilePaymentsJob(): Promise<void> {
  const pending = await query<{ id: string }>(
    `SELECT id FROM payments
      WHERE status IN ('pending','processing')
        AND provider <> 'cash'
        AND created_at < now() - interval '10 minutes'
        AND created_at > now() - interval '48 hours'
      ORDER BY created_at ASC
      LIMIT 25`,
  );

  for (const payment of pending) {
    try {
      await verifyPayment(payment.id);
    } catch (error) {
      logger.debug({ err: error, paymentId: payment.id }, 'Reconciliation attempt failed');
    }
  }
}

/** Drivers who marked themselves available and then stopped reporting. */
async function staleDriverJob(): Promise<void> {
  const rows = await query<{ id: string }>(
    `UPDATE drivers
        SET state = 'OFFLINE'
      WHERE state = 'AVAILABLE'
        AND (last_location_at IS NULL OR last_location_at < now() - interval '15 minutes')
      RETURNING id`,
  );

  if (rows.length > 0) {
    logger.info({ count: rows.length }, 'Marked stale drivers offline');
  }
}

/** Loyalty points past their expiry date. Written as ledger entries, never as
 *  a silent balance decrement. */
async function expireLoyaltyPointsJob(): Promise<void> {
  const expiring = await query<{ customer_id: string; account_id: string; points: number }>(
    `SELECT customer_id, account_id, SUM(points)::int AS points
       FROM loyalty_transactions
      WHERE type = 'earn' AND expires_at IS NOT NULL AND expires_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM loyalty_transactions e
           WHERE e.type = 'expire' AND e.customer_id = loyalty_transactions.customer_id
             AND e.created_at > loyalty_transactions.expires_at
        )
      GROUP BY customer_id, account_id`,
  );

  for (const row of expiring) {
    try {
      const account = await queryOne<{ balance_points: number }>(
        'SELECT balance_points FROM loyalty_accounts WHERE id = $1',
        [row.account_id],
      );
      const toExpire = Math.min(row.points, account?.balance_points ?? 0);
      if (toExpire <= 0) continue;

      const balanceAfter = (account?.balance_points ?? 0) - toExpire;

      await query(
        `INSERT INTO loyalty_transactions (account_id, customer_id, type, points, balance_after, reason)
         VALUES ($1, $2, 'expire', $3, $4, 'Points expired')`,
        [row.account_id, row.customer_id, -toExpire, balanceAfter],
      );
      await query('UPDATE loyalty_accounts SET balance_points = $2 WHERE id = $1', [
        row.account_id,
        balanceAfter,
      ]);
    } catch (error) {
      logger.warn({ err: error, customerId: row.customer_id }, 'Loyalty expiry failed');
    }
  }
}

async function housekeepingJob(): Promise<void> {
  const purged = await purgeExpiredIdempotencyKeys();
  if (purged > 0) logger.debug({ purged }, 'Purged expired idempotency keys');

  await query(`DELETE FROM otp_codes WHERE expires_at < now() - interval '1 day'`);
  await query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'expired'
      WHERE revoked_at IS NULL AND expires_at < now()`,
  );
}

const JOBS: Job[] = [
  { name: 'expire-offers', intervalMs: 15_000, run: expireOffersJob },
  { name: 'expire-quotes', intervalMs: 60_000, run: expireQuotesJob },
  { name: 'scheduled-rides', intervalMs: 60_000, run: scheduledRidesJob },
  { name: 'scheduled-reminders', intervalMs: 5 * 60_000, run: scheduledRemindersJob },
  { name: 'reconcile-payments', intervalMs: 5 * 60_000, run: reconcilePaymentsJob },
  { name: 'stale-drivers', intervalMs: 5 * 60_000, run: staleDriverJob },
  { name: 'expire-loyalty', intervalMs: 60 * 60_000, run: expireLoyaltyPointsJob },
  { name: 'housekeeping', intervalMs: 30 * 60_000, run: housekeepingJob },
];

export function startScheduler(): void {
  timers = JOBS.map((job) => {
    const tick = (): void => {
      // A failing job must never take the process down; it logs and waits for
      // its next turn.
      job.run().catch((error: unknown) => {
        logger.error({ err: error, job: job.name }, 'Scheduled job failed');
      });
    };

    // `unref` so a pending timer does not hold the process open during shutdown.
    const timer = setInterval(tick, job.intervalMs);
    timer.unref();
    return timer;
  });

  logger.info({ jobs: JOBS.map((job) => job.name) }, 'Background scheduler started');
}

export function stopScheduler(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
}
