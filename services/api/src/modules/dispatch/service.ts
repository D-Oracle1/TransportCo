import type { PoolClient } from 'pg';
import type { AssignmentReason, DispatchRecommendation } from '@transportco/types';
import { DEFAULT_DISPATCH_WEIGHTS, OPERATIONS_DEFAULTS } from '@transportco/config';
import { formatDistance } from '@transportco/utils';
import { LOCK_NAMESPACE, advisoryLock, query, queryOne, withTransaction } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import { computeWorkloadScore, rankCandidates, type DispatchDriverInput } from '../../domain/dispatch/scoring';
import { lockTrip, transitionTrip, type TripRow } from '../trips/repository';
import { userIdForCustomer, userIdForDriver } from '../trips/service';
import { recordAudit } from '../../services/audit';
import { notify, notifyOps } from '../../services/notifications';
import { emitToDriver, emitToOps } from '../../services/realtime/gateway';
import { logger } from '../../lib/logger';

/**
 * DISPATCH SERVICE.
 *
 * Produces recommendations and executes assignments. The scoring itself is pure
 * and lives in the domain layer; this module supplies it with real driver state
 * and then performs the assignment atomically.
 *
 * A dispatcher is always the decision-maker in Phase 1 — the system recommends,
 * a human confirms or overrides, and the override is recorded so the quality of
 * the recommendation can be reviewed against what operations actually chose.
 */

interface DriverCandidateRow {
  driver_id: string;
  full_name: string;
  photo_url: string | null;
  rating: number | null;
  state: DispatchDriverInput['state'];
  last_latitude: number | null;
  last_longitude: number | null;
  last_location_at: Date | null;
  license_expiry: Date;
  vehicle_id: string | null;
  plate_number: string | null;
  make: string | null;
  model: string | null;
  color: string | null;
  year: number | null;
  battery_percent: number | null;
  estimated_range_metres: number | null;
  active_trips: number;
  completed_today: number;
  scheduled_next_4h: number;
  on_duty_minutes_today: number;
  idle_since: Date | null;
  conflicting_scheduled: number;
}

/**
 * One query gathers everything the scorer needs. Four vehicles today, but this
 * shape stays viable at hundreds — the aggregates are per-driver subqueries
 * over indexed columns rather than a per-candidate round trip.
 */
async function loadCandidates(scheduledPickupAt: Date | null): Promise<DispatchDriverInput[]> {
  const pickupTime = scheduledPickupAt ?? new Date();

  const rows = await query<DriverCandidateRow>(
    `SELECT d.id AS driver_id, u.full_name, e.photo_url, d.rating, d.state,
            d.last_latitude, d.last_longitude, d.last_location_at, d.license_expiry,
            v.id AS vehicle_id, v.plate_number, v.make, v.model, v.color, v.year,
            v.battery_percent, v.estimated_range_metres,
            (SELECT count(*) FROM trips t
              WHERE t.driver_id = d.id
                AND t.status IN ('DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED'))::int
              AS active_trips,
            (SELECT count(*) FROM trips t
              WHERE t.driver_id = d.id AND t.completed_at >= date_trunc('day', now()))::int
              AS completed_today,
            (SELECT count(*) FROM scheduled_rides s
              WHERE s.assigned_driver_id = d.id
                AND s.status IN ('scheduled','reassigned')
                AND s.scheduled_pickup_at BETWEEN now() AND now() + interval '4 hours')::int
              AS scheduled_next_4h,
            COALESCE(EXTRACT(EPOCH FROM (now() - d.went_online_at)) / 60, 0)::int
              AS on_duty_minutes_today,
            (SELECT max(t.completed_at) FROM trips t WHERE t.driver_id = d.id) AS idle_since,
            (SELECT count(*) FROM scheduled_rides s
              WHERE s.assigned_driver_id = d.id
                AND s.status IN ('scheduled','reassigned')
                AND s.scheduled_pickup_at BETWEEN $1::timestamptz - interval '45 minutes'
                                              AND $1::timestamptz + interval '45 minutes')::int
              AS conflicting_scheduled
       FROM drivers d
       JOIN employees e ON e.id = d.employee_id
       JOIN users u ON u.id = e.user_id
       LEFT JOIN vehicles v ON v.id = d.assigned_vehicle_id AND v.status = 'active'
      WHERE d.deleted_at IS NULL
        AND e.employment_status IN ('active','probation')
        AND u.status = 'active'
        AND d.state <> 'OFFLINE'`,
    [pickupTime],
  );

  return rows.map((row) => ({
    driverId: row.driver_id,
    fullName: row.full_name,
    photoUrl: row.photo_url,
    rating: row.rating === null ? null : Number(row.rating),
    state: row.state,
    location:
      row.last_latitude !== null && row.last_longitude !== null
        ? { latitude: row.last_latitude, longitude: row.last_longitude }
        : null,
    lastLocationAt: row.last_location_at,
    workload: {
      activeTrips: row.active_trips,
      scheduledTripsNext4h: row.scheduled_next_4h,
      completedTripsToday: row.completed_today,
      onDutyMinutesToday: row.on_duty_minutes_today,
      score: computeWorkloadScore({
        activeTrips: row.active_trips,
        scheduledTripsNext4h: row.scheduled_next_4h,
        completedTripsToday: row.completed_today,
        onDutyMinutesToday: row.on_duty_minutes_today,
      }),
    },
    vehicle: row.vehicle_id
      ? {
          id: row.vehicle_id,
          plateNumber: row.plate_number!,
          make: row.make!,
          model: row.model!,
          color: row.color!,
          year: row.year,
        }
      : null,
    licenseExpiry: row.license_expiry,
    activeTripCount: row.active_trips,
    conflictingScheduledTrips: row.conflicting_scheduled,
    idleSince: row.idle_since,
    batteryPercent: row.battery_percent,
    estimatedRangeMetres: row.estimated_range_metres,
  }));
}

export async function recommendDrivers(tripId: string): Promise<DispatchRecommendation> {
  const trip = await queryOne<TripRow>('SELECT * FROM trips WHERE id = $1', [tripId]);
  if (!trip) throw notFound('Trip', tripId);

  const drivers = await loadCandidates(trip.scheduled_pickup_at);

  const { candidates, recommended } = rankCandidates(
    drivers,
    { latitude: trip.pickup_lat, longitude: trip.pickup_lng },
    {
      weights: DEFAULT_DISPATCH_WEIGHTS,
      maxPickupRadiusMetres: OPERATIONS_DEFAULTS.maxPickupRadiusMetres,
      staleLocationSeconds: OPERATIONS_DEFAULTS.staleLocationSeconds,
      tripDistanceMetres: trip.distance_metres,
      now: new Date(),
    },
  );

  return {
    tripId,
    generatedAt: new Date().toISOString(),
    candidates,
    recommended,
    weights: DEFAULT_DISPATCH_WEIGHTS,
  };
}

export interface AssignDriverInput {
  tripId: string;
  driverId: string;
  reason: AssignmentReason;
  note?: string;
  expectedVersion?: number;
  /** Null for automated assignment by the scheduler. */
  assignedByUserId: string | null;
}

/**
 * Assign (or reassign) a driver.
 *
 * Serialised per trip with an advisory lock and guarded by the trip's version,
 * so two dispatchers pressing Assign at the same moment cannot both win. The
 * previous assignment is released rather than deleted — assignment history is
 * how a reassignment complaint gets answered.
 */
export async function assignDriver(input: AssignDriverInput): Promise<{
  tripId: string;
  driverId: string;
  driverName: string;
  wasOverride: boolean;
}> {
  return withTransaction(async (client) => {
    await advisoryLock(client, LOCK_NAMESPACE.DISPATCH, input.tripId);
    const trip = await lockTrip(input.tripId, client);

    if (!trip.fare_locked_at) {
      throw new AppError({
        code: 'invalid_state_transition',
        message: 'A driver cannot be assigned before the fare is locked',
      });
    }

    const driver = await queryOne<{
      id: string;
      state: string;
      assigned_vehicle_id: string | null;
      full_name: string;
      employment_status: string;
      user_status: string;
    }>(
      `SELECT d.id, d.state, d.assigned_vehicle_id, u.full_name,
              e.employment_status, u.status AS user_status
         FROM drivers d
         JOIN employees e ON e.id = d.employee_id
         JOIN users u ON u.id = e.user_id
        WHERE d.id = $1 AND d.deleted_at IS NULL
        FOR UPDATE OF d`,
      [input.driverId],
      client,
    );

    if (!driver) throw notFound('Driver', input.driverId);

    if (driver.user_status !== 'active' || !['active', 'probation'].includes(driver.employment_status)) {
      throw new AppError({ code: 'driver_unavailable', message: 'That driver is not active' });
    }

    if (['OFFLINE', 'SUSPENDED'].includes(driver.state)) {
      throw new AppError({
        code: 'driver_unavailable',
        message: `${driver.full_name} is ${driver.state.toLowerCase()} and cannot take this trip`,
      });
    }

    // A driver already carrying a trip cannot take another. The database also
    // guards this via the one-active-assignment index; this is the friendly
    // version of that error.
    const busy = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM trips
        WHERE driver_id = $1 AND id <> $2
          AND status IN ('DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED')`,
      [input.driverId, input.tripId],
      client,
    );

    if ((busy?.count ?? 0) > 0 && trip.type === 'immediate') {
      throw new AppError({
        code: 'driver_unavailable',
        message: `${driver.full_name} is already on a trip`,
      });
    }

    const previousDriverId = trip.driver_id;
    const isReassignment = previousDriverId !== null && previousDriverId !== input.driverId;

    // Was the recommendation followed? Recorded so dispatch quality is
    // measurable rather than a matter of opinion.
    let recommendationScore: number | null = null;
    let wasOverride = false;
    try {
      const recommendation = await recommendDrivers(input.tripId);
      const chosen = recommendation.candidates.find((c) => c.driverId === input.driverId);
      recommendationScore = chosen?.score ?? null;
      wasOverride =
        recommendation.recommended !== null && recommendation.recommended.driverId !== input.driverId;
    } catch (error) {
      logger.warn({ err: error, tripId: input.tripId }, 'Could not score the assignment');
    }

    if (previousDriverId) {
      await client.query(
        `UPDATE trip_assignments SET active = false, released_at = now() WHERE trip_id = $1 AND active`,
        [input.tripId],
      );
      await client.query(
        `UPDATE drivers SET state = 'AVAILABLE' WHERE id = $1 AND state IN ('ASSIGNED','PICKING_UP','ARRIVED')`,
        [previousDriverId],
      );
    }

    await client.query(
      `INSERT INTO trip_assignments (
         trip_id, driver_id, vehicle_id, assigned_by_user_id, reason, recommendation_score, was_override, note
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.tripId,
        input.driverId,
        driver.assigned_vehicle_id,
        input.assignedByUserId,
        input.reason,
        recommendationScore,
        wasOverride,
        input.note ?? null,
      ],
    );

    // REASSIGNED and DRIVER_UNAVAILABLE both route back to DRIVER_ASSIGNED.
    const assigned = await transitionTrip(client, trip, 'DRIVER_ASSIGNED', input.assignedByUserId ? 'admin' : 'system', {
      reason: input.note ?? input.reason,
      expectedVersion: input.expectedVersion,
      patch: {
        driver_id: input.driverId,
        vehicle_id: driver.assigned_vehicle_id,
        assigned_at: new Date(),
      },
      metadata: { reason: input.reason, wasOverride, recommendationScore },
    });

    await client.query(`UPDATE drivers SET state = 'ASSIGNED' WHERE id = $1`, [input.driverId]);

    await client.query(
      `UPDATE scheduled_rides SET assigned_driver_id = $2, status = 'scheduled',
              reassignment_count = reassignment_count + $3
        WHERE trip_id = $1`,
      [input.tripId, input.driverId, isReassignment ? 1 : 0],
    );

    await recordAudit(
      {
        action: isReassignment ? 'trip.driver_reassigned' : 'trip.driver_assigned',
        resourceType: 'trip',
        resourceId: input.tripId,
        previousValue: previousDriverId ? { driverId: previousDriverId } : null,
        newValue: { driverId: input.driverId, reason: input.reason, wasOverride },
        reason: input.note ?? null,
      },
      client,
    );

    // --- Notifications ------------------------------------------------------
    const vehicle = driver.assigned_vehicle_id
      ? await queryOne<{ make: string; model: string; plate_number: string; color: string }>(
          'SELECT make, model, plate_number, color FROM vehicles WHERE id = $1',
          [driver.assigned_vehicle_id],
          client,
        )
      : null;

    await notify({
      userId: await userIdForCustomer(trip.customer_id, client),
      event: isReassignment ? 'customer.driver_changed' : 'customer.driver_assigned',
      data: {
        driverName: driver.full_name,
        vehicle: vehicle ? `${vehicle.color} ${vehicle.make} ${vehicle.model}` : 'company vehicle',
        plate: vehicle?.plate_number ?? '',
      },
      dedupeKey: `trip:${input.tripId}:assigned:${input.driverId}`,
    }).catch(() => undefined);

    await notify({
      userId: await userIdForDriver(input.driverId, client),
      event: 'driver.trip_assigned',
      data: { customerName: 'your customer', pickup: trip.pickup_address, reference: trip.reference },
      dedupeKey: `trip:${input.tripId}:driver_assigned:${input.driverId}`,
    }).catch(() => undefined);

    if (previousDriverId) {
      await notify({
        userId: await userIdForDriver(previousDriverId, client),
        event: 'driver.trip_reassigned',
        data: { reference: trip.reference },
      }).catch(() => undefined);
    }

    emitToDriver(input.driverId, 'trip.driver_assigned', {
      tripId: assigned.id,
      reference: assigned.reference,
    });
    emitToOps('trip.driver_assigned', {
      tripId: assigned.id,
      reference: assigned.reference,
      driverId: input.driverId,
    });

    return {
      tripId: assigned.id,
      driverId: input.driverId,
      driverName: driver.full_name,
      wasOverride,
    };
  });
}

/**
 * A driver can no longer take an assigned trip (sick, vehicle fault, no-show).
 *
 * Deliberately does NOT auto-reassign. It flags the trip, alerts operations and
 * offers a ranked replacement — a customer who was told "Michael is coming"
 * deserves a human confirming who is coming instead.
 */
export async function markDriverUnavailable(args: {
  tripId: string;
  reason: string;
  actorUserId: string | null;
}): Promise<{ tripId: string; replacement: DispatchRecommendation['recommended'] }> {
  const result = await withTransaction(async (client) => {
    const trip = await lockTrip(args.tripId, client);
    const previousDriverId = trip.driver_id;

    await transitionTrip(client, trip, 'DRIVER_UNAVAILABLE', args.actorUserId ? 'admin' : 'system', {
      reason: args.reason,
      patch: { driver_id: null },
    });

    if (previousDriverId) {
      await client.query(
        `UPDATE trip_assignments SET active = false, released_at = now() WHERE trip_id = $1 AND active`,
        [args.tripId],
      );
      await client.query(
        `UPDATE drivers SET state = 'AVAILABLE' WHERE id = $1 AND state IN ('ASSIGNED','PICKING_UP','ARRIVED')`,
        [previousDriverId],
      );
    }

    await client.query(
      `UPDATE scheduled_rides SET status = 'driver_unavailable', assigned_driver_id = NULL WHERE trip_id = $1`,
      [args.tripId],
    );

    return { trip, previousDriverId };
  });

  await notifyOps('admin.driver_unavailable', {
    reference: result.trip.reference,
    driverName: 'the assigned driver',
    tripId: args.tripId,
  }).catch(() => undefined);

  const recommendation = await recommendDrivers(args.tripId);
  return { tripId: args.tripId, replacement: recommendation.recommended };
}

/** The live operations board: unassigned work with a recommendation attached. */
export async function dispatchBoard(): Promise<
  Array<{
    tripId: string;
    reference: string;
    status: string;
    customerName: string;
    pickupAddress: string;
    destinationAddress: string;
    fareMinor: number;
    scheduledPickupAt: string | null;
    waitingSeconds: number;
    recommended: { driverId: string; name: string; distanceLabel: string; score: number; workload: string } | null;
  }>
> {
  const trips = await query<{
    id: string;
    reference: string;
    status: string;
    customer_name: string;
    pickup_address: string;
    destination_address: string;
    final_fare_minor: number | null;
    quoted_fare_minor: number;
    scheduled_pickup_at: Date | null;
    fare_locked_at: Date | null;
  }>(
    `SELECT t.id, t.reference, t.status, u.full_name AS customer_name,
            t.pickup_address, t.destination_address, t.final_fare_minor, t.quoted_fare_minor,
            t.scheduled_pickup_at, t.fare_locked_at
       FROM trips t
       JOIN customers c ON c.id = t.customer_id
       JOIN users u ON u.id = c.user_id
      WHERE t.driver_id IS NULL
        AND t.status IN ('FARE_LOCKED','DRIVER_UNAVAILABLE','REASSIGNED')
      ORDER BY COALESCE(t.scheduled_pickup_at, t.fare_locked_at, t.created_at) ASC
      LIMIT 50`,
  );

  return Promise.all(
    trips.map(async (trip) => {
      let recommended = null as Awaited<ReturnType<typeof dispatchBoard>>[number]['recommended'];

      try {
        const recommendation = await recommendDrivers(trip.id);
        if (recommendation.recommended) {
          const candidate = recommendation.recommended;
          recommended = {
            driverId: candidate.driverId,
            name: candidate.fullName,
            distanceLabel:
              candidate.distanceToPickupMetres === null
                ? 'Unknown'
                : formatDistance(candidate.distanceToPickupMetres),
            score: candidate.score,
            workload:
              candidate.workload.score < 0.34 ? 'Low' : candidate.workload.score < 0.67 ? 'Medium' : 'High',
          };
        }
      } catch (error) {
        logger.warn({ err: error, tripId: trip.id }, 'Recommendation failed for dispatch board');
      }

      return {
        tripId: trip.id,
        reference: trip.reference,
        status: trip.status,
        customerName: trip.customer_name,
        pickupAddress: trip.pickup_address,
        destinationAddress: trip.destination_address,
        fareMinor: trip.final_fare_minor ?? trip.quoted_fare_minor,
        scheduledPickupAt: trip.scheduled_pickup_at?.toISOString() ?? null,
        waitingSeconds: Math.max(
          0,
          Math.round((Date.now() - (trip.fare_locked_at ?? new Date()).getTime()) / 1000),
        ),
        recommended,
      };
    }),
  );
}

/** Used by the scheduled-ride worker to commit a driver at booking time. */
export async function autoAssignBest(
  tripId: string,
  reason: AssignmentReason = 'initial_assignment',
): Promise<string | null> {
  const recommendation = await recommendDrivers(tripId);
  if (!recommendation.recommended) return null;

  const result = await assignDriver({
    tripId,
    driverId: recommendation.recommended.driverId,
    reason,
    assignedByUserId: null,
    note: 'Automatically assigned by dispatch',
  });

  return result.driverId;
}
