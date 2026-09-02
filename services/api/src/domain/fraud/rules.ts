import type { FraudSignalCode } from '@transportco/types';
import { query } from '../../db/pool';
import { logger } from '../../lib/logger';
import { notifyOps } from '../../services/notifications';

/**
 * Fraud detection — rules, audit trails and anomaly indicators.
 *
 * Deliberately NOT a machine-learning system. At four vehicles there is no
 * training data, and a model that cannot explain itself is useless to an
 * operations team that has to confront a specific driver about a specific trip.
 *
 * What this gives instead: a small set of legible rules, each writing a signal
 * a human reviews. Every signal names the evidence.
 */

export interface FraudSignalInput {
  code: FraudSignalCode;
  severity: 'info' | 'warning' | 'critical';
  subjectType: 'customer' | 'driver' | 'admin' | 'trip';
  subjectId: string;
  tripId?: string | null;
  details: Record<string, unknown>;
}

export async function recordFraudSignal(input: FraudSignalInput): Promise<void> {
  try {
    await query(
      `INSERT INTO fraud_signals (code, severity, subject_type, subject_id, trip_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.code,
        input.severity,
        input.subjectType,
        input.subjectId,
        input.tripId ?? null,
        JSON.stringify(input.details),
      ],
    );

    logger.warn({ ...input }, 'Fraud signal recorded');

    if (input.severity === 'critical') {
      await notifyOps('admin.fraud_signal', {
        code: input.code,
        subject: `${input.subjectType}:${input.subjectId}`,
      }).catch(() => undefined);
    }
  } catch (error) {
    // A failed signal write must never block the business operation that
    // triggered it — a trip still completes even if we cannot flag it.
    logger.error({ err: error, code: input.code }, 'Failed to record fraud signal');
  }
}

/**
 * Customer-side checks, run when a trip is cancelled and on sign-up.
 *
 * Thresholds are intentionally forgiving: in a market where network drops and
 * address confusion are routine, an aggressive rule punishes ordinary
 * customers, and the cost of a false accusation is far higher than the cost of
 * one abused cancellation.
 */
export async function evaluateCustomerRisk(customerId: string): Promise<void> {
  const stats = await query<{ cancellations: number; trips: number }>(
    `SELECT
       count(*) FILTER (WHERE status = 'CANCELLED' AND cancelled_by_type = 'customer')::int AS cancellations,
       count(*)::int AS trips
     FROM trips
     WHERE customer_id = $1 AND created_at > now() - interval '7 days'`,
    [customerId],
  );

  const row = stats[0];
  if (!row) return;

  if (row.cancellations >= 5 && row.cancellations / Math.max(row.trips, 1) > 0.6) {
    await recordFraudSignal({
      code: 'customer.repeated_cancellations',
      severity: 'warning',
      subjectType: 'customer',
      subjectId: customerId,
      details: { cancellations: row.cancellations, tripsInWindow: row.trips, windowDays: 7 },
    });
  }
}

/** Multiple accounts from one handset — the usual referral-abuse pattern. */
export async function evaluateDuplicateDevice(customerId: string, deviceId: string | null): Promise<void> {
  if (!deviceId) return;

  const rows = await query<{ count: number }>(
    'SELECT count(*)::int AS count FROM customers WHERE signup_device_id = $1',
    [deviceId],
  );

  const count = rows[0]?.count ?? 0;
  if (count > 2) {
    await recordFraudSignal({
      code: 'customer.duplicate_device',
      severity: 'info',
      subjectType: 'customer',
      subjectId: customerId,
      details: { deviceId, accountsOnDevice: count },
    });
  }
}

/**
 * Administrator checks. The insider risks are the ones nobody wants to name in
 * a design document, and precisely the ones an audited system must watch:
 * refund velocity, fare overrides and self-approval.
 */
export async function evaluateAdminRisk(actorUserId: string): Promise<void> {
  const rows = await query<{ refunds: number; overrides: number }>(
    `SELECT
       count(*) FILTER (WHERE action = 'payment.refunded')::int AS refunds,
       count(*) FILTER (WHERE action IN ('fare.adjusted','negotiation.floor_overridden'))::int AS overrides
     FROM audit_logs
     WHERE actor_user_id = $1 AND created_at > now() - interval '24 hours'`,
    [actorUserId],
  );

  const row = rows[0];
  if (!row) return;

  if (row.refunds >= 10) {
    await recordFraudSignal({
      code: 'admin.refund_velocity',
      severity: 'critical',
      subjectType: 'admin',
      subjectId: actorUserId,
      details: { refundsIn24h: row.refunds },
    });
  }

  if (row.overrides >= 15) {
    await recordFraudSignal({
      code: 'admin.fare_override_velocity',
      severity: 'warning',
      subjectType: 'admin',
      subjectId: actorUserId,
      details: { overridesIn24h: row.overrides },
    });
  }
}

/**
 * Route deviation: the trip took materially longer than quoted with no
 * corresponding distance. Informational — Port Harcourt traffic explains most
 * of these, which is exactly why it is a signal for a human and not an
 * automatic penalty.
 */
export async function evaluateRouteDeviation(args: {
  tripId: string;
  driverId: string;
  quotedDistanceMetres: number;
  actualDistanceMetres: number | null;
}): Promise<void> {
  if (args.actualDistanceMetres == null || args.quotedDistanceMetres <= 0) return;

  const ratio = args.actualDistanceMetres / args.quotedDistanceMetres;
  if (ratio > 1.6) {
    await recordFraudSignal({
      code: 'driver.route_deviation',
      severity: 'info',
      subjectType: 'driver',
      subjectId: args.driverId,
      tripId: args.tripId,
      details: {
        quotedMetres: args.quotedDistanceMetres,
        actualMetres: args.actualDistanceMetres,
        ratio: Math.round(ratio * 100) / 100,
      },
    });
  }
}
