import type { PoolClient } from 'pg';
import type { TransitionActorType, TripStatus } from '@transportco/types';
import { query, queryOne } from '../../db/pool';
import { AppError, notFound, versionConflict } from '../../lib/errors';
import { checkTransition } from '../../domain/trip/stateMachine';
import { currentActor } from '../../lib/context';
import { emitToCustomer, emitToOps, emitToTrip } from '../../services/realtime/gateway';
import { logger } from '../../lib/logger';

export interface TripRow {
  id: string;
  reference: string;
  customer_id: string;
  driver_id: string | null;
  vehicle_id: string | null;
  status: TripStatus;
  type: 'immediate' | 'scheduled';
  pickup_lat: number;
  pickup_lng: number;
  pickup_address: string;
  pickup_place_id: string | null;
  destination_lat: number;
  destination_lng: number;
  destination_address: string;
  destination_place_id: string | null;
  passengers: number;
  special_instructions: string | null;
  distance_metres: number;
  duration_seconds: number;
  route_provider: string;
  route_polyline: string | null;
  currency: 'NGN';
  quoted_fare_minor: number;
  final_fare_minor: number | null;
  fare_breakdown: unknown;
  fare_quote_id: string | null;
  pricing_rule_set_id: string;
  pricing_version: number;
  fare_locked_at: Date | null;
  scheduled_pickup_at: Date | null;
  assigned_at: Date | null;
  driver_en_route_at: Date | null;
  driver_arrived_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  cancelled_by_type: TransitionActorType | null;
  cancellation_fee_minor: number | null;
  payment_method: 'cash' | 'card' | 'bank_transfer' | 'wallet' | null;
  payment_status: 'unpaid' | 'pending' | 'paid' | 'failed' | 'refunded' | 'partially_refunded';
  actual_distance_metres: number | null;
  actual_duration_seconds: number | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export async function findTripById(id: string, client?: PoolClient): Promise<TripRow | null> {
  return queryOne<TripRow>('SELECT * FROM trips WHERE id = $1', [id], client);
}

/** Loads a trip and takes a row lock. Every state change starts here. */
export async function lockTrip(id: string, client: PoolClient): Promise<TripRow> {
  const trip = await queryOne<TripRow>('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [id], client);
  if (!trip) throw notFound('Trip', id);
  return trip;
}

export interface TransitionOptions {
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Fields to update alongside the status, e.g. driver_id or timestamps. */
  patch?: Record<string, unknown>;
  /** Optimistic concurrency guard supplied by an admin client. */
  expectedVersion?: number;
  /** Set by an administrator exercising `trip:force_state`. Audited by the caller. */
  forced?: boolean;
  /** Overrides the ambient actor for background workers. */
  actorUserId?: string | null;
}

/**
 * THE ONLY WAY A TRIP'S STATUS CHANGES.
 *
 * Validates the transition against the state machine, applies it with an
 * optimistic-concurrency check, appends a history row, and fans the change out
 * over realtime — atomically, inside the caller's transaction.
 *
 * The version check is what makes two dispatchers clicking "Assign" at the same
 * instant safe: the second write matches zero rows and raises a conflict rather
 * than quietly overwriting the first.
 */
export async function transitionTrip(
  client: PoolClient,
  trip: TripRow,
  to: TripStatus,
  actor: TransitionActorType,
  options: TransitionOptions = {},
): Promise<TripRow> {
  if (options.expectedVersion !== undefined && options.expectedVersion !== trip.version) {
    throw versionConflict('trip');
  }

  const patch = options.patch ?? {};

  const check = checkTransition(trip.status, to, actor, {
    hasDriver: Boolean(patch.driver_id ?? trip.driver_id),
    hasFinalFare: (patch.final_fare_minor ?? trip.final_fare_minor) !== null,
    fareLocked: Boolean(patch.fare_locked_at ?? trip.fare_locked_at),
    paymentSettled:
      (patch.payment_status ?? trip.payment_status) === 'paid' || to !== 'PAYMENT_COMPLETED',
    forced: options.forced ?? false,
  });

  if (!check.allowed) {
    throw new AppError({
      code: 'invalid_state_transition',
      message: check.failure?.message ?? 'That change is not allowed for this trip',
      logContext: { tripId: trip.id, from: trip.status, to, actor },
    });
  }

  const columns = ['status = $2', 'version = version + 1'];
  const params: unknown[] = [trip.id, to];

  for (const [column, value] of Object.entries(patch)) {
    params.push(value);
    columns.push(`${column} = $${params.length}`);
  }

  params.push(trip.version);

  const updated = await queryOne<TripRow>(
    `UPDATE trips SET ${columns.join(', ')} WHERE id = $1 AND version = $${params.length} RETURNING *`,
    params,
    client,
  );

  if (!updated) throw versionConflict('trip');

  const actorUserId = options.actorUserId !== undefined ? options.actorUserId : currentActor().userId;

  await client.query(
    `INSERT INTO trip_status_history (trip_id, from_status, to_status, actor_type, actor_user_id, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      trip.id,
      trip.status,
      to,
      actor,
      actorUserId,
      options.reason ?? null,
      options.metadata ? JSON.stringify(options.metadata) : null,
    ],
  );

  logger.info(
    { tripId: trip.id, reference: trip.reference, from: trip.status, to, actor },
    'Trip state changed',
  );

  // Fan-out happens after the write. A listener that reacts to a status it can
  // then fail to read in the database would be a genuinely confusing bug.
  const payload = { tripId: trip.id, reference: trip.reference, status: to, previousStatus: trip.status };
  emitToTrip(trip.id, 'trip.status_changed', payload);
  emitToCustomer(trip.customer_id, 'trip.status_changed', payload);
  emitToOps('trip.status_changed', payload);

  return updated;
}

export async function nextTripReference(client: PoolClient): Promise<string> {
  const row = await queryOne<{ value: number }>(
    "SELECT nextval('seq_trip_reference')::int AS value",
    [],
    client,
  );
  return `TRP-${row?.value ?? Date.now()}`;
}

export async function tripHistory(tripId: string): Promise<
  Array<{
    from_status: TripStatus | null;
    to_status: TripStatus;
    actor_type: TransitionActorType;
    reason: string | null;
    created_at: Date;
    actor_name: string | null;
  }>
> {
  return query(
    `SELECT h.from_status, h.to_status, h.actor_type, h.reason, h.created_at, u.full_name AS actor_name
       FROM trip_status_history h
       LEFT JOIN users u ON u.id = h.actor_user_id
      WHERE h.trip_id = $1
      ORDER BY h.created_at ASC`,
    [tripId],
  );
}

/** Active trips occupying a driver right now. */
export async function activeTripCountForDriver(driverId: string, client?: PoolClient): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM trips
      WHERE driver_id = $1
        AND status IN ('DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED')`,
    [driverId],
    client,
  );
  return row?.count ?? 0;
}
