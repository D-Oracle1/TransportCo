import type { PaymentMethod, TransitionActorType } from '@transportco/types';
import { formatMoney } from '@transportco/utils';
import { OPERATIONS_DEFAULTS } from '@transportco/config';
import type { PoolClient } from 'pg';
import { LOCK_NAMESPACE, advisoryLock, queryOne, withTransaction } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import { cancellationFee } from '../../domain/pricing/engine';
import { recordAudit } from '../../services/audit';
import { notify, notifyOps } from '../../services/notifications';
import { consumeQuote } from '../pricing/service';
import { getPricingRuleSetById } from '../pricing/repository';
import { openNegotiation } from '../negotiation/service';
import { lockTrip, nextTripReference, transitionTrip, type TripRow } from './repository';

/**
 * TRIP SERVICE — the orchestration layer for a trip's life.
 *
 * Rules enforced here rather than trusted to callers:
 *   - A trip is created from a QUOTE, never from a client-supplied fare.
 *   - A customer with an outstanding balance above the configured threshold
 *     cannot start a new trip. This is the counterweight to not demanding a
 *     card at sign-up.
 *   - Locking a fare is a distinct, audited step, and the database refuses to
 *     let the locked amount change afterwards.
 */

export interface CreateTripInput {
  customerId: string;
  quoteId: string;
  paymentMethod: PaymentMethod;
  specialInstructions?: string;
}

export interface CreatedTrip {
  tripId: string;
  reference: string;
  status: string;
  quotedFareMinor: number;
  negotiable: boolean;
  negotiationId: string | null;
  maxOffers: number;
  offerExpirySeconds: number;
}

async function assertNoBlockingBalance(customerId: string, client: PoolClient): Promise<void> {
  const row = await queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(amount_minor - settled_amount_minor), 0)::bigint AS total
       FROM outstanding_balances
      WHERE customer_id = $1 AND status IN ('outstanding', 'partially_settled')`,
    [customerId],
    client,
  );

  const outstanding = Number(row?.total ?? 0);
  if (outstanding <= 0) return;

  const rules = await (await import('../pricing/repository')).getActivePricingRuleSet();
  const threshold = rules.cancellation.blockNewTripsAboveOutstandingMinor;

  if (threshold > 0 && outstanding > threshold) {
    throw new AppError({
      code: 'outstanding_balance',
      message: `You have ${formatMoney(outstanding)} outstanding. Please settle it to book another ride.`,
      logContext: { customerId, outstanding },
    });
  }
}

export async function createTrip(input: CreateTripInput): Promise<CreatedTrip> {
  return withTransaction(async (client) => {
    await assertNoBlockingBalance(input.customerId, client);

    const quote = await consumeQuote(input.quoteId, input.customerId, client);
    const rules = await getPricingRuleSetById(quote.pricing_rule_set_id);
    const reference = await nextTripReference(client);
    const isScheduled = quote.scheduled_for !== null;

    const trip = await queryOne<TripRow>(
      `INSERT INTO trips (
         reference, customer_id, status, type,
         pickup_lat, pickup_lng, pickup_address, pickup_place_id,
         destination_lat, destination_lng, destination_address, destination_place_id,
         passengers, special_instructions,
         distance_metres, duration_seconds, route_provider, route_polyline,
         quoted_fare_minor, fare_breakdown, fare_quote_id, pricing_rule_set_id, pricing_version,
         scheduled_pickup_at, payment_method
       ) VALUES ($1,$2,'REQUESTED',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [
        reference,
        input.customerId,
        isScheduled ? 'scheduled' : 'immediate',
        quote.pickup_lat,
        quote.pickup_lng,
        quote.pickup_address,
        quote.pickup_place_id,
        quote.destination_lat,
        quote.destination_lng,
        quote.destination_address,
        quote.destination_place_id,
        quote.passengers,
        input.specialInstructions ?? null,
        quote.distance_metres,
        quote.duration_seconds,
        quote.route_provider,
        quote.route_polyline,
        quote.quoted_fare_minor,
        JSON.stringify(quote.breakdown),
        quote.id,
        quote.pricing_rule_set_id,
        quote.pricing_version,
        quote.scheduled_for,
        input.paymentMethod,
      ],
      // MUST run on the transaction's client. `consumeQuote` holds a FOR UPDATE
      // lock on the quote row, and this INSERT takes a foreign key to it — on a
      // different pooled connection it would wait for a lock held by the
      // transaction that is waiting for it. A self-deadlock, resolved only by
      // the query timeout.
      client,
    );

    await client.query("UPDATE fare_quotes SET status = 'consumed' WHERE id = $1", [quote.id]);

    // REQUESTED -> FARE_CALCULATED is a system step: the fare already exists,
    // it came from the quote, and the customer never supplied it.
    const priced = await transitionTrip(client, trip!, 'FARE_CALCULATED', 'system', {
      reason: 'Fare calculated from quote',
      metadata: { quoteId: quote.id, pricingVersion: quote.pricing_version },
    });

    let negotiationId: string | null = null;
    if (rules.negotiation.enabled) {
      negotiationId = await openNegotiation(client, {
        tripId: priced.id,
        customerId: input.customerId,
        originalFareMinor: quote.quoted_fare_minor,
        floorMinor: quote.floor_minor,
        autoAcceptAtOrAboveMinor: quote.auto_accept_at_minor,
        maxCustomerRounds: rules.negotiation.maxCustomerRounds,
        pricingRuleSetId: quote.pricing_rule_set_id,
        pricingVersion: quote.pricing_version,
      });
    }

    if (isScheduled) {
      await client.query(
        `INSERT INTO scheduled_rides (trip_id, customer_id, scheduled_pickup_at, dispatch_due_at)
         VALUES ($1, $2, $3, $4)`,
        [
          priced.id,
          input.customerId,
          quote.scheduled_for,
          new Date(
            quote.scheduled_for!.getTime() - OPERATIONS_DEFAULTS.scheduledDispatchLeadSeconds * 1000,
          ),
        ],
      );
    }

    return {
      tripId: priced.id,
      reference: priced.reference,
      status: priced.status,
      quotedFareMinor: priced.quoted_fare_minor,
      negotiable: rules.negotiation.enabled,
      negotiationId,
      maxOffers: rules.negotiation.maxCustomerRounds,
      offerExpirySeconds: rules.negotiation.offerTtlSeconds,
    };
  });
}

/**
 * Accepting a fare and locking it.
 *
 * FARE_ACCEPTED and FARE_LOCKED are separate states on purpose: acceptance is
 * the customer's act, locking is the company's. Between them the system writes
 * the final amount; after them the database trigger refuses to let it change.
 */
export async function lockFare(
  client: PoolClient,
  trip: TripRow,
  finalFareMinor: number,
  actor: TransitionActorType,
  reason: string,
): Promise<TripRow> {
  const accepted = await transitionTrip(client, trip, 'FARE_ACCEPTED', actor, {
    reason,
    patch: { final_fare_minor: finalFareMinor },
  });

  const locked = await transitionTrip(client, accepted, 'FARE_LOCKED', 'system', {
    reason: 'Fare locked',
    patch: { fare_locked_at: new Date() },
  });

  await recordAudit(
    {
      action: 'fare.locked',
      resourceType: 'trip',
      resourceId: trip.id,
      previousValue: { quotedFareMinor: trip.quoted_fare_minor },
      newValue: { finalFareMinor },
      reason,
    },
    client,
  );

  await notify({
    userId: await userIdForCustomer(locked.customer_id, client),
    event: 'customer.fare_accepted',
    data: { fare: formatMoney(finalFareMinor), reference: locked.reference },
    dedupeKey: `trip:${locked.id}:fare_accepted`,
  }).catch(() => undefined);

  await notifyOps('admin.trip_unassigned', {
    reference: locked.reference,
    tripId: locked.id,
  }).catch(() => undefined);

  return locked;
}

export async function userIdForCustomer(customerId: string, client?: PoolClient): Promise<string> {
  const row = await queryOne<{ user_id: string }>(
    'SELECT user_id FROM customers WHERE id = $1',
    [customerId],
    client,
  );
  if (!row) throw notFound('Customer', customerId);
  return row.user_id;
}

export async function userIdForDriver(driverId: string, client?: PoolClient): Promise<string> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT e.user_id FROM drivers d JOIN employees e ON e.id = d.employee_id WHERE d.id = $1`,
    [driverId],
    client,
  );
  if (!row) throw notFound('Driver', driverId);
  return row.user_id;
}

export interface CancelTripInput {
  tripId: string;
  actor: TransitionActorType;
  reason: string;
  note?: string;
  /** Customers may only cancel their own trip. */
  customerId?: string;
}

export interface CancelResult {
  tripId: string;
  feeMinor: number;
  feeReason: string;
  outstandingBalanceCreated: boolean;
}

/**
 * Cancellation.
 *
 * The fee comes from the pricing rule set that priced THIS trip, not from the
 * current one — a customer must not be charged under a policy published after
 * they booked. An unpaid fee becomes an outstanding balance rather than a
 * surprise card charge, since we deliberately never took a card.
 */
export async function cancelTrip(input: CancelTripInput): Promise<CancelResult> {
  return withTransaction(async (client) => {
    await advisoryLock(client, LOCK_NAMESPACE.TRIP, input.tripId);
    const trip = await lockTrip(input.tripId, client);

    if (input.customerId && trip.customer_id !== input.customerId) {
      throw new AppError({ code: 'forbidden', message: 'That trip belongs to another account' });
    }

    const rules = await getPricingRuleSetById(trip.pricing_rule_set_id);
    const fee = cancellationFee(rules, {
      status: trip.status,
      fareLockedAt: trip.fare_locked_at,
      scheduledPickupAt: trip.scheduled_pickup_at,
      now: new Date(),
    });

    const cancelled = await transitionTrip(client, trip, 'CANCELLED', input.actor, {
      reason: input.reason,
      metadata: { note: input.note ?? null, feeReason: fee.reasonCode },
      patch: {
        cancelled_at: new Date(),
        cancellation_reason: input.reason,
        cancelled_by_type: input.actor,
        cancellation_fee_minor: fee.feeMinor,
      },
    });

    let outstandingBalanceCreated = false;

    if (fee.feeMinor > 0) {
      await client.query(
        `INSERT INTO outstanding_balances (customer_id, trip_id, reason, amount_minor, status)
         VALUES ($1, $2, 'cancellation_fee', $3, 'outstanding')`,
        [trip.customer_id, trip.id, fee.feeMinor],
      );
      await client.query('UPDATE customers SET has_outstanding_balance = true WHERE id = $1', [
        trip.customer_id,
      ]);
      outstandingBalanceCreated = true;
    }

    // Release the driver and the assignment record.
    if (trip.driver_id) {
      await client.query(
        `UPDATE trip_assignments SET active = false, released_at = now()
          WHERE trip_id = $1 AND active`,
        [trip.id],
      );
      await client.query(
        `UPDATE drivers SET state = 'AVAILABLE' WHERE id = $1 AND state IN ('ASSIGNED','PICKING_UP','ARRIVED')`,
        [trip.driver_id],
      );

      await notify({
        userId: await userIdForDriver(trip.driver_id, client),
        event: 'driver.trip_cancelled',
        data: { reference: trip.reference },
        dedupeKey: `trip:${trip.id}:driver_cancelled`,
      }).catch(() => undefined);
    }

    await client.query(
      `UPDATE scheduled_rides SET status = 'cancelled' WHERE trip_id = $1`,
      [trip.id],
    );

    await recordAudit(
      {
        action: 'trip.cancelled',
        resourceType: 'trip',
        resourceId: trip.id,
        previousValue: { status: trip.status },
        newValue: { status: 'CANCELLED', feeMinor: fee.feeMinor },
        reason: input.reason,
      },
      client,
    );

    if (input.actor !== 'customer') {
      await notify({
        userId: await userIdForCustomer(trip.customer_id, client),
        event: 'customer.trip_cancelled',
        data: { reason: input.note ?? 'Your trip has been cancelled.' },
        dedupeKey: `trip:${trip.id}:cancelled`,
      }).catch(() => undefined);
    }

    if (fee.feeMinor > 0) {
      await notify({
        userId: await userIdForCustomer(trip.customer_id, client),
        event: 'customer.outstanding_balance',
        data: { amount: formatMoney(fee.feeMinor) },
        dedupeKey: `trip:${trip.id}:cancellation_fee`,
      }).catch(() => undefined);
    }

    return {
      tripId: cancelled.id,
      feeMinor: fee.feeMinor,
      feeReason: fee.reasonCode,
      outstandingBalanceCreated,
    };
  });
}

/** What a cancellation would cost right now — shown before the customer confirms. */
export async function previewCancellation(
  tripId: string,
  customerId: string,
): Promise<{ feeMinor: number; reasonCode: string; message: string }> {
  const trip = await queryOne<TripRow>('SELECT * FROM trips WHERE id = $1', [tripId]);
  if (!trip) throw notFound('Trip', tripId);
  if (trip.customer_id !== customerId) {
    throw new AppError({ code: 'forbidden', message: 'That trip belongs to another account' });
  }

  const rules = await getPricingRuleSetById(trip.pricing_rule_set_id);
  const fee = cancellationFee(rules, {
    status: trip.status,
    fareLockedAt: trip.fare_locked_at,
    scheduledPickupAt: trip.scheduled_pickup_at,
    now: new Date(),
  });

  return {
    feeMinor: fee.feeMinor,
    reasonCode: fee.reasonCode,
    message:
      fee.feeMinor === 0
        ? 'You can cancel this trip at no charge.'
        : `Cancelling now costs ${formatMoney(fee.feeMinor)}, which will be added to your balance.`,
  };
}
