import type { DriverState, TripStatus } from '@transportco/types';
import { OPERATIONS_DEFAULTS } from '@transportco/config';
import { haversineMetres, speedBetween } from '@transportco/utils';
import { query, queryOne, withTransaction } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import { lockTrip, transitionTrip } from '../trips/repository';
import { userIdForCustomer } from '../trips/service';
import { notify } from '../../services/notifications';
import { emitToCustomer, emitToOps, emitToTrip } from '../../services/realtime/gateway';
import { recordFraudSignal } from '../../domain/fraud/rules';
import { logger } from '../../lib/logger';

/**
 * DRIVER SERVICE.
 *
 * The driver app is an execution surface, not a marketplace client. Everything
 * it can do is here, and the list is deliberately short: change availability,
 * report location, and advance the trip it has been given.
 *
 * There is no endpoint anywhere in this codebase that lets a driver see a
 * negotiation, change a fare, or choose a trip.
 */

const PICKUP_ARRIVAL_RADIUS_METRES = 250;

export async function setDriverState(
  driverId: string,
  requested: 'OFFLINE' | 'ONLINE' | 'AVAILABLE' | 'ON_BREAK',
): Promise<{ state: DriverState }> {
  return withTransaction(async (client) => {
    const driver = await queryOne<{ id: string; state: DriverState; assigned_vehicle_id: string | null }>(
      'SELECT id, state, assigned_vehicle_id FROM drivers WHERE id = $1 FOR UPDATE',
      [driverId],
      client,
    );
    if (!driver) throw notFound('Driver', driverId);

    // A driver mid-trip cannot go offline; the trip must be completed or
    // reassigned by operations first. Otherwise a customer is left standing on
    // a road with a driver who vanished from the system.
    const engaged: DriverState[] = ['ASSIGNED', 'PICKING_UP', 'ARRIVED', 'ON_TRIP'];
    if (engaged.includes(driver.state)) {
      throw new AppError({
        code: 'conflict',
        message: 'You have an active trip. Complete it or contact operations first.',
      });
    }

    if (driver.state === 'SUSPENDED') {
      throw new AppError({ code: 'forbidden', message: 'Your account is suspended. Contact operations.' });
    }

    if (requested !== 'OFFLINE' && !driver.assigned_vehicle_id) {
      throw new AppError({
        code: 'conflict',
        message: 'No vehicle is assigned to you. Contact operations before going online.',
      });
    }

    // ONLINE and AVAILABLE are the same operational state at launch: a driver
    // who is online with no trip is dispatchable.
    const next: DriverState = requested === 'ONLINE' ? 'AVAILABLE' : requested;

    await client.query(
      `UPDATE drivers
          SET state = $2,
              went_online_at = CASE WHEN $2 <> 'OFFLINE' AND state = 'OFFLINE' THEN now()
                                    WHEN $2 = 'OFFLINE' THEN NULL
                                    ELSE went_online_at END
        WHERE id = $1`,
      [driverId, next],
    );

    emitToOps('driver.state_changed', { driverId, state: next });
    return { state: next };
  });
}

export interface LocationPing {
  latitude: number;
  longitude: number;
  headingDegrees?: number | null;
  speedMetresPerSecond?: number | null;
  accuracyMetres?: number | null;
  recordedAt: string;
  tripId?: string | null;
}

/**
 * Record driver location.
 *
 * Accepts a batch, because the driver app queues fixes while offline and flushes
 * them on reconnect. Two properties matter here:
 *
 *  - Out-of-order and replayed fixes must not corrupt the "last known position".
 *    Only a fix newer than the stored one updates the driver row.
 *  - An implausible jump between consecutive fixes raises a fraud signal rather
 *    than being written as truth. GPS spoofing is a real problem in this market.
 */
export async function recordLocations(
  driverId: string,
  pings: LocationPing[],
): Promise<{ accepted: number; rejected: number }> {
  if (pings.length === 0) return { accepted: 0, rejected: 0 };

  const driver = await queryOne<{
    state: DriverState;
    last_latitude: number | null;
    last_longitude: number | null;
    last_location_at: Date | null;
  }>('SELECT state, last_latitude, last_longitude, last_location_at FROM drivers WHERE id = $1', [driverId]);

  if (!driver) throw notFound('Driver', driverId);

  const ordered = [...pings].sort(
    (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
  );

  let previous =
    driver.last_latitude !== null && driver.last_longitude !== null && driver.last_location_at
      ? {
          point: { latitude: driver.last_latitude, longitude: driver.last_longitude },
          at: driver.last_location_at,
        }
      : null;

  let accepted = 0;
  let rejected = 0;

  for (const ping of ordered) {
    const recordedAt = new Date(ping.recordedAt);

    // A timestamp from the future is a broken device clock, not a position.
    if (recordedAt.getTime() > Date.now() + 60_000) {
      rejected += 1;
      continue;
    }

    if (previous) {
      const speed = speedBetween(previous.point, previous.at, { latitude: ping.latitude, longitude: ping.longitude }, recordedAt);
      if (speed !== null && speed > OPERATIONS_DEFAULTS.gpsImplausibleSpeedMps) {
        await recordFraudSignal({
          code: 'driver.gps_jump',
          severity: 'warning',
          subjectType: 'driver',
          subjectId: driverId,
          tripId: ping.tripId ?? null,
          details: {
            impliedSpeedMps: Math.round(speed),
            from: previous.point,
            to: { latitude: ping.latitude, longitude: ping.longitude },
          },
        });
        rejected += 1;
        continue;
      }
    }

    await query(
      `INSERT INTO driver_locations (
         driver_id, trip_id, latitude, longitude, heading_degrees, speed_mps, accuracy_metres, driver_state, recorded_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        driverId,
        ping.tripId ?? null,
        ping.latitude,
        ping.longitude,
        ping.headingDegrees ?? null,
        ping.speedMetresPerSecond ?? null,
        ping.accuracyMetres ?? null,
        driver.state,
        recordedAt,
      ],
    );

    if (ping.tripId) {
      await query(
        `INSERT INTO trip_locations (
           trip_id, driver_id, latitude, longitude, heading_degrees, speed_mps, accuracy_metres, recorded_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          ping.tripId,
          driverId,
          ping.latitude,
          ping.longitude,
          ping.headingDegrees ?? null,
          ping.speedMetresPerSecond ?? null,
          ping.accuracyMetres ?? null,
          recordedAt,
        ],
      );
    }

    previous = { point: { latitude: ping.latitude, longitude: ping.longitude }, at: recordedAt };
    accepted += 1;
  }

  if (previous) {
    // `last_location_at < $4` keeps a delayed offline flush from overwriting a
    // fresher live position.
    await query(
      `UPDATE drivers
          SET last_latitude = $2, last_longitude = $3, last_location_at = $4, last_heading = $5
        WHERE id = $1 AND (last_location_at IS NULL OR last_location_at < $4)`,
      [driverId, previous.point.latitude, previous.point.longitude, previous.at, ordered.at(-1)?.headingDegrees ?? null],
    );
  }

  const latest = ordered.at(-1);
  if (latest) {
    const payload = {
      driverId,
      latitude: latest.latitude,
      longitude: latest.longitude,
      heading: latest.headingDegrees ?? null,
      at: latest.recordedAt,
    };

    emitToOps('driver.location', payload);

    // The customer sees the driver only while the driver is actually coming for
    // them or carrying them — not whenever the driver happens to be online.
    if (latest.tripId) {
      emitToTrip(latest.tripId, 'trip.driver_location', payload);
    }
  }

  return { accepted, rejected };
}

type DriverAction = 'start_pickup' | 'arrived' | 'start_trip' | 'complete_trip' | 'report_no_show';

const ACTION_TO_STATUS: Record<DriverAction, TripStatus> = {
  start_pickup: 'DRIVER_EN_ROUTE',
  arrived: 'DRIVER_ARRIVED',
  start_trip: 'TRIP_STARTED',
  complete_trip: 'TRIP_COMPLETED',
  report_no_show: 'NO_SHOW',
};

const ACTION_TO_DRIVER_STATE: Partial<Record<DriverAction, DriverState>> = {
  start_pickup: 'PICKING_UP',
  arrived: 'ARRIVED',
  start_trip: 'ON_TRIP',
  complete_trip: 'AVAILABLE',
  report_no_show: 'AVAILABLE',
};

/**
 * The driver advances their trip.
 *
 * The trip state machine decides whether the move is legal; this adds the
 * physical checks that a state machine cannot know — chiefly that a driver
 * claiming to have arrived is actually near the pickup point.
 */
export async function performTripAction(args: {
  driverId: string;
  tripId: string;
  action: DriverAction;
  latitude?: number;
  longitude?: number;
  note?: string;
}): Promise<{ status: TripStatus; paymentDue: boolean; amountMinor: number | null }> {
  return withTransaction(async (client) => {
    const trip = await lockTrip(args.tripId, client);

    if (trip.driver_id !== args.driverId) {
      throw new AppError({ code: 'forbidden', message: 'This trip is not assigned to you' });
    }

    const target = ACTION_TO_STATUS[args.action];
    const patch: Record<string, unknown> = {};
    const now = new Date();

    switch (args.action) {
      case 'start_pickup':
        patch.driver_en_route_at = now;
        break;

      case 'arrived': {
        patch.driver_arrived_at = now;

        // Arrival starts the customer's no-show clock and can trigger a fee, so
        // it needs to be true. A driver 4 km away marking "arrived" is either a
        // mistake or an attempt to start that clock early.
        if (args.latitude != null && args.longitude != null) {
          const distance = haversineMetres(
            { latitude: args.latitude, longitude: args.longitude },
            { latitude: trip.pickup_lat, longitude: trip.pickup_lng },
          );

          if (distance > PICKUP_ARRIVAL_RADIUS_METRES) {
            throw new AppError({
              code: 'validation_failed',
              message: `You are ${Math.round(distance)} m from the pickup point. Move closer before marking arrival.`,
              logContext: { tripId: args.tripId, distance },
            });
          }
        }
        break;
      }

      case 'start_trip':
        patch.started_at = now;
        break;

      case 'complete_trip': {
        patch.completed_at = now;

        // Distance actually driven, from the breadcrumb trail. A completion
        // with no movement at all is a fraud signal, not a completed trip.
        const travelled = await queryOne<{ metres: number | null; points: number }>(
          `SELECT count(*)::int AS points,
                  COALESCE(SUM(step), 0)::int AS metres
             FROM (
               SELECT 6371000 * acos(LEAST(1,
                        cos(radians(lag(latitude) OVER w)) * cos(radians(latitude)) *
                        cos(radians(longitude) - radians(lag(longitude) OVER w)) +
                        sin(radians(lag(latitude) OVER w)) * sin(radians(latitude))
                      )) AS step
                 FROM trip_locations
                WHERE trip_id = $1
               WINDOW w AS (ORDER BY recorded_at)
             ) steps`,
          [args.tripId],
          client,
        );

        if (travelled?.metres != null && travelled.points > 2) {
          patch.actual_distance_metres = travelled.metres;

          if (travelled.metres < 200 && trip.distance_metres > 1_000) {
            await recordFraudSignal({
              code: 'driver.completion_without_movement',
              severity: 'critical',
              subjectType: 'driver',
              subjectId: args.driverId,
              tripId: args.tripId,
              details: { recordedMetres: travelled.metres, quotedMetres: trip.distance_metres },
            });
          }
        }

        if (trip.started_at) {
          patch.actual_duration_seconds = Math.round((now.getTime() - trip.started_at.getTime()) / 1000);
        }
        break;
      }

      case 'report_no_show': {
        if (!trip.driver_arrived_at) {
          throw new AppError({
            code: 'validation_failed',
            message: 'Mark your arrival before reporting a no-show',
          });
        }

        const waitedSeconds = (now.getTime() - trip.driver_arrived_at.getTime()) / 1000;
        const rules = await (await import('../pricing/repository')).getPricingRuleSetById(
          trip.pricing_rule_set_id,
        );

        if (waitedSeconds < rules.cancellation.noShowWaitSeconds) {
          const remaining = Math.ceil((rules.cancellation.noShowWaitSeconds - waitedSeconds) / 60);
          throw new AppError({
            code: 'validation_failed',
            message: `Please wait ${remaining} more minute(s) before reporting a no-show.`,
          });
        }
        break;
      }
    }

    const updated = await transitionTrip(client, trip, target, 'driver', {
      reason: args.note ?? `Driver action: ${args.action}`,
      patch,
      metadata: args.latitude != null ? { latitude: args.latitude, longitude: args.longitude } : null,
    });

    const nextDriverState = ACTION_TO_DRIVER_STATE[args.action];
    if (nextDriverState) {
      await client.query('UPDATE drivers SET state = $2 WHERE id = $1', [args.driverId, nextDriverState]);
    }

    if (args.action === 'complete_trip') {
      await client.query('UPDATE drivers SET total_trips = total_trips + 1 WHERE id = $1', [args.driverId]);
      await client.query('UPDATE customers SET total_trips = total_trips + 1 WHERE id = $1', [
        trip.customer_id,
      ]);
      await client.query("UPDATE scheduled_rides SET status = 'completed' WHERE trip_id = $1", [
        args.tripId,
      ]);

      // Cash is settled by the driver at the roadside; everything else needs a
      // payment step before the trip can close.
      const paymentTarget: TripStatus =
        updated.payment_status === 'paid' ? 'PAYMENT_COMPLETED' : 'PAYMENT_PENDING';

      await transitionTrip(client, updated, paymentTarget, 'system', {
        reason: 'Trip completed; awaiting settlement',
      });
    }

    if (args.action === 'report_no_show') {
      const rules = await (await import('../pricing/repository')).getPricingRuleSetById(
        trip.pricing_rule_set_id,
      );
      const fee = rules.cancellation.noShowFeeMinor;

      if (fee > 0) {
        await client.query(
          `INSERT INTO outstanding_balances (customer_id, trip_id, reason, amount_minor, status)
           VALUES ($1, $2, 'no_show_fee', $3, 'outstanding')`,
          [trip.customer_id, trip.id, fee],
        );
        await client.query('UPDATE customers SET has_outstanding_balance = true WHERE id = $1', [
          trip.customer_id,
        ]);
      }
    }

    // Customer-facing notifications for the moments that matter on the street.
    const customerUserId = await userIdForCustomer(trip.customer_id, client);
    if (args.action === 'start_pickup') {
      await notify({
        userId: customerUserId,
        event: 'customer.driver_approaching',
        data: { driverName: 'Your driver', minutes: Math.round(trip.duration_seconds / 60) },
        dedupeKey: `trip:${trip.id}:en_route`,
      }).catch(() => undefined);
    } else if (args.action === 'arrived') {
      await notify({
        userId: customerUserId,
        event: 'customer.driver_arrived',
        data: { driverName: 'Your driver', vehicle: 'your vehicle', plate: '' },
        dedupeKey: `trip:${trip.id}:arrived`,
      }).catch(() => undefined);
    } else if (args.action === 'start_trip') {
      await notify({
        userId: customerUserId,
        event: 'customer.trip_started',
        dedupeKey: `trip:${trip.id}:started`,
      }).catch(() => undefined);
    }

    emitToCustomer(trip.customer_id, 'trip.status_changed', { tripId: trip.id, status: target });

    const paymentDue = args.action === 'complete_trip' && updated.payment_status !== 'paid';

    return {
      status: target,
      paymentDue,
      amountMinor: paymentDue ? updated.final_fare_minor : null,
    };
  });
}

/** The driver's own dashboard. Contains no negotiation data by construction. */
export async function driverDashboard(driverId: string) {
  const [profile, today, active, upcoming] = await Promise.all([
    queryOne<{
      state: DriverState;
      rating: number | null;
      total_trips: number;
      full_name: string;
      plate_number: string | null;
      make: string | null;
      model: string | null;
    }>(
      `SELECT d.state, d.rating, d.total_trips, u.full_name,
              v.plate_number, v.make, v.model
         FROM drivers d
         JOIN employees e ON e.id = d.employee_id
         JOIN users u ON u.id = e.user_id
         LEFT JOIN vehicles v ON v.id = d.assigned_vehicle_id
        WHERE d.id = $1`,
      [driverId],
    ),
    queryOne<{ trips: number; distance: number | null }>(
      `SELECT count(*)::int AS trips, COALESCE(SUM(actual_distance_metres), 0)::int AS distance
         FROM trips
        WHERE driver_id = $1 AND completed_at >= date_trunc('day', now())`,
      [driverId],
    ),
    query(
      `SELECT t.id, t.reference, t.status, t.pickup_address, t.destination_address,
              t.final_fare_minor, t.payment_method, u.full_name AS customer_name
         FROM trips t
         JOIN customers c ON c.id = t.customer_id
         JOIN users u ON u.id = c.user_id
        WHERE t.driver_id = $1
          AND t.status IN ('DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED')
        ORDER BY t.assigned_at ASC`,
      [driverId],
    ),
    query(
      `SELECT t.id, t.reference, t.scheduled_pickup_at, t.pickup_address, t.destination_address,
              t.final_fare_minor, u.full_name AS customer_name
         FROM scheduled_rides s
         JOIN trips t ON t.id = s.trip_id
         JOIN customers c ON c.id = t.customer_id
         JOIN users u ON u.id = c.user_id
        WHERE s.assigned_driver_id = $1
          AND s.status IN ('scheduled','reassigned')
          AND s.scheduled_pickup_at > now()
        ORDER BY s.scheduled_pickup_at ASC
        LIMIT 10`,
      [driverId],
    ),
  ]);

  if (!profile) throw notFound('Driver', driverId);

  return {
    driver: {
      fullName: profile.full_name,
      state: profile.state,
      rating: profile.rating === null ? null : Number(profile.rating),
      totalTrips: profile.total_trips,
      vehicle: profile.plate_number
        ? { plateNumber: profile.plate_number, make: profile.make, model: profile.model }
        : null,
    },
    today: { trips: today?.trips ?? 0, distanceMetres: today?.distance ?? 0 },
    activeTrips: active,
    upcomingTrips: upcoming,
  };
}

/** Emergency contact for the driver app's SOS screen. */
export function operationsHotline(): string {
  return process.env.OPS_EMERGENCY_HOTLINE ?? '+2340000000000';
}
