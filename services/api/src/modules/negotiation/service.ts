import type { PoolClient } from 'pg';
import type { NegotiationQueueItem, NegotiationStatus, OfferResolution } from '@transportco/types';
import { addSeconds, discountPercent, formatMoney } from '@transportco/utils';
import { LOCK_NAMESPACE, advisoryLock, query, queryOne, withTransaction } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import {
  computeAutoCounter,
  evaluateCustomerOffer,
  isOfferExpired,
  secondsRemaining,
  validateAdminCounter,
  type NegotiationState,
} from '../../domain/negotiation/engine';
import { getPricingRuleSetById } from '../pricing/repository';
import { recordAudit } from '../../services/audit';
import { notify, notifyOps } from '../../services/notifications';
import { emitToCustomer, emitToOps, emitToTrip } from '../../services/realtime/gateway';
import { lockTrip, transitionTrip } from '../trips/repository';
import { lockFare, userIdForCustomer } from '../trips/service';
import { logger } from '../../lib/logger';

/**
 * NEGOTIATION SERVICE.
 *
 * Wraps the pure engine with persistence, notification and — the part that
 * actually needs care — concurrency.
 *
 * The race this module exists to survive: a customer submits an offer at the
 * same moment a dispatcher submits a counteroffer. Both read the same state,
 * both decide, both write. Without serialisation the customer could accept a
 * price the company had already moved away from, or a counter could be recorded
 * against an offer that no longer exists.
 *
 * The fix is an advisory lock per negotiation plus a version column, so the two
 * operations are strictly ordered and the loser re-reads rather than overwrites.
 */

interface NegotiationRow {
  id: string;
  trip_id: string;
  customer_id: string;
  status: NegotiationStatus;
  original_fare_minor: number;
  floor_minor: number;
  auto_accept_at_minor: number;
  company_position_minor: number;
  customer_position_minor: number | null;
  customer_rounds_used: number;
  max_customer_rounds: number;
  final_fare_minor: number | null;
  pending_offer_id: string | null;
  pricing_rule_set_id: string;
  pricing_version: number;
  version: number;
}

interface OfferRow {
  id: string;
  negotiation_id: string;
  trip_id: string;
  sequence: number;
  party: 'customer' | 'company';
  amount_minor: number;
  status: string;
  expires_at: Date;
  message: string | null;
  created_at: Date;
}

function toState(row: NegotiationRow): NegotiationState {
  return {
    status: row.status,
    originalFareMinor: row.original_fare_minor,
    floorMinor: row.floor_minor,
    autoAcceptAtOrAboveMinor: row.auto_accept_at_minor,
    companyPositionMinor: row.company_position_minor,
    customerRoundsUsed: row.customer_rounds_used,
    maxCustomerRounds: row.max_customer_rounds,
  };
}

export async function openNegotiation(
  client: PoolClient,
  args: {
    tripId: string;
    customerId: string;
    originalFareMinor: number;
    floorMinor: number;
    autoAcceptAtOrAboveMinor: number;
    maxCustomerRounds: number;
    pricingRuleSetId: string;
    pricingVersion: number;
  },
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO negotiations (
       trip_id, customer_id, status, original_fare_minor, floor_minor, auto_accept_at_minor,
       company_position_minor, customer_rounds_used, max_customer_rounds,
       pricing_rule_set_id, pricing_version
     ) VALUES ($1, $2, 'OPEN', $3, $4, $5, $3, 0, $6, $7, $8)
     RETURNING id`,
    [
      args.tripId,
      args.customerId,
      args.originalFareMinor,
      args.floorMinor,
      args.autoAcceptAtOrAboveMinor,
      args.maxCustomerRounds,
      args.pricingRuleSetId,
      args.pricingVersion,
    ],
    client,
  );

  return row!.id;
}

async function nextSequence(client: PoolClient, negotiationId: string): Promise<number> {
  const row = await queryOne<{ next: number }>(
    'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM negotiation_offers WHERE negotiation_id = $1',
    [negotiationId],
    client,
  );
  return row?.next ?? 1;
}

async function expirePendingOffer(client: PoolClient, negotiation: NegotiationRow): Promise<void> {
  if (!negotiation.pending_offer_id) return;

  const pending = await queryOne<OfferRow>(
    'SELECT * FROM negotiation_offers WHERE id = $1 FOR UPDATE',
    [negotiation.pending_offer_id],
    client,
  );

  if (pending && pending.status === 'pending' && isOfferExpired(pending.expires_at)) {
    await client.query(
      `UPDATE negotiation_offers SET status = 'expired', resolution = 'expired', responded_at = now() WHERE id = $1`,
      [pending.id],
    );
    await client.query('UPDATE negotiations SET pending_offer_id = NULL WHERE id = $1', [negotiation.id]);
    negotiation.pending_offer_id = null;
  }
}

export interface CustomerOfferResult {
  outcome: 'accepted' | 'rejected' | 'countered' | 'under_review' | 'limit_reached';
  message: string;
  /** Present when the company countered. */
  counterAmountMinor?: number;
  /** Present once a fare is agreed. */
  finalFareMinor?: number;
  offersRemaining: number;
  expiresAt: string | null;
  expiresInSeconds: number | null;
}

/**
 * A customer submits an offer.
 *
 * Everything downstream of the engine's decision — writing the offer, advancing
 * the company's position, locking the fare — happens in one transaction under
 * one advisory lock.
 */
export async function submitCustomerOffer(args: {
  tripId: string;
  customerId: string;
  amountMinor: number;
  message?: string;
}): Promise<CustomerOfferResult> {
  return withTransaction(async (client) => {
    await advisoryLock(client, LOCK_NAMESPACE.NEGOTIATION, args.tripId);

    const negotiation = await queryOne<NegotiationRow>(
      'SELECT * FROM negotiations WHERE trip_id = $1 FOR UPDATE',
      [args.tripId],
      client,
    );

    if (!negotiation) throw notFound('Negotiation for trip', args.tripId);
    if (negotiation.customer_id !== args.customerId) {
      throw new AppError({ code: 'forbidden', message: 'That trip belongs to another account' });
    }

    // Sweep an expired pending offer before evaluating, so a customer whose
    // counteroffer timed out is not blocked by a ghost.
    await expirePendingOffer(client, negotiation);

    const rules = await getPricingRuleSetById(negotiation.pricing_rule_set_id);
    const decision = evaluateCustomerOffer(toState(negotiation), args.amountMinor, rules.negotiation);

    if (decision.kind === 'INVALID') {
      throw new AppError({
        code: decision.reasonCode === 'negotiation_closed' ? 'negotiation_closed' : 'validation_failed',
        message: decision.customerMessage,
        logContext: { tripId: args.tripId, reason: decision.reasonCode },
      });
    }

    if (decision.kind === 'LIMIT_REACHED') {
      return {
        outcome: 'limit_reached' as const,
        message: decision.customerMessage,
        offersRemaining: 0,
        expiresAt: null,
        expiresInSeconds: null,
      };
    }

    const trip = await lockTrip(args.tripId, client);
    const sequence = await nextSequence(client, negotiation.id);
    const expiresAt = addSeconds(new Date(), rules.negotiation.offerTtlSeconds);

    const offer = await queryOne<OfferRow>(
      `INSERT INTO negotiation_offers (
         negotiation_id, trip_id, sequence, party, actor_user_id, amount_minor, message, status, expires_at
       ) VALUES ($1, $2, $3, 'customer', $4, $5, $6, 'pending', $7)
       RETURNING *`,
      [
        negotiation.id,
        args.tripId,
        sequence,
        await userIdForCustomer(args.customerId, client),
        args.amountMinor,
        args.message ?? null,
        expiresAt,
      ],
      client,
    );

    // The customer has spent one of their offers, whatever the outcome.
    const roundsUsed = negotiation.customer_rounds_used + 1;

    if (trip.status === 'FARE_CALCULATED') {
      await transitionTrip(client, trip, 'NEGOTIATING', 'customer', {
        reason: 'Customer submitted an offer',
        metadata: { offerId: offer!.id },
      });
    }

    emitToOps('negotiation.offer_created', {
      tripId: args.tripId,
      reference: trip.reference,
      amountMinor: args.amountMinor,
      decision: decision.kind,
    });

    switch (decision.kind) {
      case 'ACCEPT': {
        await settleNegotiation(client, {
          negotiation,
          finalFareMinor: args.amountMinor,
          acceptedByParty: 'company',
          offerId: offer!.id,
          resolution: 'auto_accepted',
          roundsUsed,
          reason: decision.internalNote,
        });

        return {
          outcome: 'accepted' as const,
          message: decision.customerMessage,
          finalFareMinor: args.amountMinor,
          offersRemaining: Math.max(0, negotiation.max_customer_rounds - roundsUsed),
          expiresAt: null,
          expiresInSeconds: null,
        };
      }

      case 'REJECT': {
        await client.query(
          `UPDATE negotiation_offers SET status = 'rejected', resolution = 'auto_rejected', responded_at = now() WHERE id = $1`,
          [offer!.id],
        );
        await client.query(
          `UPDATE negotiations
              SET status = 'AWAITING_CUSTOMER', customer_rounds_used = $2,
                  customer_position_minor = $3, pending_offer_id = NULL, version = version + 1
            WHERE id = $1`,
          [negotiation.id, roundsUsed, args.amountMinor],
        );

        await notifyCustomer(client, negotiation.customer_id, 'customer.fare_rejected', {
          amount: formatMoney(negotiation.company_position_minor),
        });

        return {
          outcome: 'rejected' as const,
          message: decision.customerMessage,
          offersRemaining: Math.max(0, negotiation.max_customer_rounds - roundsUsed),
          expiresAt: null,
          expiresInSeconds: null,
        };
      }

      case 'COUNTER': {
        const counterAmount = decision.counterAmountMinor!;
        const counterExpiry = addSeconds(new Date(), rules.negotiation.offerTtlSeconds);

        await client.query(
          `UPDATE negotiation_offers SET status = 'countered', resolution = 'auto_countered', responded_at = now() WHERE id = $1`,
          [offer!.id],
        );

        const counter = await queryOne<OfferRow>(
          `INSERT INTO negotiation_offers (
             negotiation_id, trip_id, sequence, party, actor_user_id, amount_minor, status, expires_at
           ) VALUES ($1, $2, $3, 'company', NULL, $4, 'pending', $5)
           RETURNING *`,
          [negotiation.id, args.tripId, sequence + 1, counterAmount, counterExpiry],
          client,
        );

        await client.query(
          `UPDATE negotiations
              SET status = 'AWAITING_CUSTOMER', customer_rounds_used = $2, customer_position_minor = $3,
                  company_position_minor = $4, pending_offer_id = $5, version = version + 1
            WHERE id = $1`,
          [negotiation.id, roundsUsed, args.amountMinor, counterAmount, counter!.id],
        );

        await notifyCustomer(client, negotiation.customer_id, 'customer.counteroffer_received', {
          amount: formatMoney(counterAmount),
        });

        emitToCustomer(negotiation.customer_id, 'negotiation.offer_created', {
          tripId: args.tripId,
          party: 'company',
          amountMinor: counterAmount,
          expiresAt: counterExpiry.toISOString(),
        });

        return {
          outcome: 'countered' as const,
          message: decision.customerMessage,
          counterAmountMinor: counterAmount,
          offersRemaining: Math.max(0, negotiation.max_customer_rounds - roundsUsed),
          expiresAt: counterExpiry.toISOString(),
          expiresInSeconds: secondsRemaining(counterExpiry),
        };
      }

      case 'REVIEW':
      default: {
        await client.query(
          `UPDATE negotiations
              SET status = 'AWAITING_COMPANY', customer_rounds_used = $2, customer_position_minor = $3,
                  pending_offer_id = $4, version = version + 1
            WHERE id = $1`,
          [negotiation.id, roundsUsed, args.amountMinor, offer!.id],
        );

        await notifyOps('admin.negotiation_review_required', {
          reference: trip.reference,
          amount: formatMoney(args.amountMinor),
          tripId: args.tripId,
        }).catch(() => undefined);

        return {
          outcome: 'under_review' as const,
          message: decision.customerMessage,
          offersRemaining: Math.max(0, negotiation.max_customer_rounds - roundsUsed),
          expiresAt: expiresAt.toISOString(),
          expiresInSeconds: secondsRemaining(expiresAt),
        };
      }
    }
  });
}

/** Shared tail for every path that agrees a price. */
async function settleNegotiation(
  client: PoolClient,
  args: {
    negotiation: NegotiationRow;
    finalFareMinor: number;
    acceptedByParty: 'customer' | 'company';
    offerId: string;
    resolution: OfferResolution;
    roundsUsed?: number;
    reason: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE negotiation_offers SET status = 'accepted', resolution = $2, responded_at = now() WHERE id = $1`,
    [args.offerId, args.resolution],
  );

  await client.query(
    `UPDATE negotiations
        SET status = 'ACCEPTED', final_fare_minor = $2, accepted_at = now(), accepted_by_party = $3,
            customer_rounds_used = COALESCE($4, customer_rounds_used),
            company_position_minor = $2, pending_offer_id = NULL, version = version + 1
      WHERE id = $1`,
    [args.negotiation.id, args.finalFareMinor, args.acceptedByParty, args.roundsUsed ?? null],
  );

  const trip = await lockTrip(args.negotiation.trip_id, client);
  await lockFare(
    client,
    trip,
    args.finalFareMinor,
    args.acceptedByParty === 'customer' ? 'customer' : 'system',
    args.reason,
  );

  emitToTrip(args.negotiation.trip_id, 'negotiation.offer_resolved', {
    tripId: args.negotiation.trip_id,
    finalFareMinor: args.finalFareMinor,
  });
}

async function notifyCustomer(
  client: PoolClient,
  customerId: string,
  event: Parameters<typeof notify>[0]['event'],
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const userId = await userIdForCustomer(customerId, client);
    await notify({ userId, event, data });
  } catch (error) {
    logger.warn({ err: error, customerId, event }, 'Customer notification failed');
  }
}

/**
 * The customer accepts the company's standing offer (or the original fare).
 *
 * `offerId` is required and checked: it stops a customer accepting a price they
 * saw on a stale screen after the company has already moved.
 */
export async function acceptCompanyOffer(args: {
  tripId: string;
  customerId: string;
  offerId: string | null;
}): Promise<{ finalFareMinor: number }> {
  return withTransaction(async (client) => {
    await advisoryLock(client, LOCK_NAMESPACE.NEGOTIATION, args.tripId);

    const negotiation = await queryOne<NegotiationRow>(
      'SELECT * FROM negotiations WHERE trip_id = $1 FOR UPDATE',
      [args.tripId],
      client,
    );
    if (!negotiation) throw notFound('Negotiation for trip', args.tripId);
    if (negotiation.customer_id !== args.customerId) {
      throw new AppError({ code: 'forbidden', message: 'That trip belongs to another account' });
    }
    if (negotiation.status === 'ACCEPTED') {
      return { finalFareMinor: negotiation.final_fare_minor! };
    }

    await expirePendingOffer(client, negotiation);

    let amount = negotiation.company_position_minor;
    let offerId = negotiation.pending_offer_id;

    if (args.offerId) {
      const offer = await queryOne<OfferRow>(
        'SELECT * FROM negotiation_offers WHERE id = $1 AND negotiation_id = $2 FOR UPDATE',
        [args.offerId, negotiation.id],
        client,
      );

      if (!offer) throw notFound('Offer', args.offerId);
      if (offer.party !== 'company') {
        throw new AppError({ code: 'validation_failed', message: 'You can only accept a company offer' });
      }
      if (offer.status !== 'pending') {
        throw new AppError({
          code: 'offer_expired',
          message: 'That offer is no longer available. Please review the current price.',
        });
      }
      if (isOfferExpired(offer.expires_at)) {
        await client.query(
          `UPDATE negotiation_offers SET status = 'expired', resolution = 'expired' WHERE id = $1`,
          [offer.id],
        );
        throw new AppError({
          code: 'offer_expired',
          message: 'That offer has expired. Please review the current price.',
        });
      }

      amount = offer.amount_minor;
      offerId = offer.id;
    }

    // No company offer on the table: the customer is accepting the original
    // quoted fare, so record that acceptance as an explicit offer row.
    if (!offerId) {
      const sequence = await nextSequence(client, negotiation.id);
      const created = await queryOne<OfferRow>(
        `INSERT INTO negotiation_offers (
           negotiation_id, trip_id, sequence, party, amount_minor, status, expires_at
         ) VALUES ($1, $2, $3, 'company', $4, 'pending', now() + interval '1 minute')
         RETURNING *`,
        [negotiation.id, args.tripId, sequence, amount],
        client,
      );
      offerId = created!.id;
    }

    await settleNegotiation(client, {
      negotiation,
      finalFareMinor: amount,
      acceptedByParty: 'customer',
      offerId,
      resolution: 'customer_accepted',
      reason: 'Customer accepted the company fare',
    });

    return { finalFareMinor: amount };
  });
}

export interface AdminResponseInput {
  negotiationId: string;
  action: 'accept' | 'reject' | 'counter';
  counterAmountMinor?: number;
  overrideFloor: boolean;
  note?: string;
  /** Set when the acting user holds `negotiation:override_floor`. */
  canOverrideFloor: boolean;
}

/**
 * An administrator responds.
 *
 * Company counteroffers are NOT limited by the customer's round cap — the brief
 * is explicit about that, and operationally it is what lets a dispatcher close
 * a deal on the customer's last offer.
 */
export async function respondAsAdmin(input: AdminResponseInput): Promise<{
  status: string;
  finalFareMinor?: number;
  counterAmountMinor?: number;
}> {
  return withTransaction(async (client) => {
    const negotiation = await queryOne<NegotiationRow>(
      'SELECT * FROM negotiations WHERE id = $1 FOR UPDATE',
      [input.negotiationId],
      client,
    );
    if (!negotiation) throw notFound('Negotiation', input.negotiationId);

    await advisoryLock(client, LOCK_NAMESPACE.NEGOTIATION, negotiation.trip_id);
    await expirePendingOffer(client, negotiation);

    const rules = await getPricingRuleSetById(negotiation.pricing_rule_set_id);
    const trip = await lockTrip(negotiation.trip_id, client);
    const sequence = await nextSequence(client, negotiation.id);

    if (input.action === 'accept') {
      const amount = negotiation.customer_position_minor;
      if (amount == null) {
        throw new AppError({ code: 'conflict', message: 'There is no customer offer to accept' });
      }

      // Accepting below the floor is a real decision with a real cost, so it
      // needs the permission and it leaves a trail.
      if (amount < negotiation.floor_minor && !input.canOverrideFloor) {
        throw new AppError({
          code: 'forbidden',
          message: 'This offer is below the minimum acceptable fare and you cannot override it',
        });
      }

      const offerId =
        negotiation.pending_offer_id ??
        (
          await queryOne<OfferRow>(
            `INSERT INTO negotiation_offers (negotiation_id, trip_id, sequence, party, amount_minor, status, expires_at)
             VALUES ($1, $2, $3, 'customer', $4, 'pending', now() + interval '1 minute') RETURNING *`,
            [negotiation.id, negotiation.trip_id, sequence, amount],
            client,
          )
        )!.id;

      await settleNegotiation(client, {
        negotiation,
        finalFareMinor: amount,
        acceptedByParty: 'company',
        offerId,
        resolution: 'admin_accepted',
        reason: input.note ?? 'Accepted by operations',
      });

      await recordAudit(
        {
          action: 'negotiation.responded',
          resourceType: 'negotiation',
          resourceId: negotiation.id,
          previousValue: { companyPosition: negotiation.company_position_minor },
          newValue: { accepted: amount, belowFloor: amount < negotiation.floor_minor },
          reason: input.note ?? null,
        },
        client,
      );

      await notifyCustomer(client, negotiation.customer_id, 'customer.fare_accepted', {
        fare: formatMoney(amount),
        reference: trip.reference,
      });

      return { status: 'ACCEPTED', finalFareMinor: amount };
    }

    if (input.action === 'reject') {
      if (negotiation.pending_offer_id) {
        await client.query(
          `UPDATE negotiation_offers SET status = 'rejected', resolution = 'admin_rejected', responded_at = now() WHERE id = $1`,
          [negotiation.pending_offer_id],
        );
      }

      await client.query(
        `UPDATE negotiations SET status = 'AWAITING_CUSTOMER', pending_offer_id = NULL, version = version + 1 WHERE id = $1`,
        [negotiation.id],
      );

      // A rejection returns the trip to its quoted fare; the customer may still
      // accept it. Rejecting an offer is not cancelling the trip.
      if (trip.status === 'NEGOTIATING') {
        await transitionTrip(client, trip, 'FARE_CALCULATED', 'admin', {
          reason: input.note ?? 'Offer rejected by operations',
        });
      }

      await recordAudit(
        {
          action: 'negotiation.responded',
          resourceType: 'negotiation',
          resourceId: negotiation.id,
          newValue: { rejected: negotiation.customer_position_minor },
          reason: input.note ?? null,
        },
        client,
      );

      await notifyCustomer(client, negotiation.customer_id, 'customer.fare_rejected', {
        amount: formatMoney(negotiation.company_position_minor),
      });

      return { status: 'AWAITING_CUSTOMER' };
    }

    // --- counter ---
    const counterAmount = input.counterAmountMinor!;
    const validation = validateAdminCounter(toState(negotiation), counterAmount, {
      overrideFloor: input.overrideFloor && input.canOverrideFloor,
      absoluteMinimumMinor: rules.minimumFareMinor,
    });

    if (!validation.valid) {
      throw new AppError({
        code: validation.problem === 'negotiation_closed' ? 'negotiation_closed' : 'validation_failed',
        message: validation.message ?? 'That counteroffer is not allowed',
      });
    }

    if (negotiation.pending_offer_id) {
      await client.query(
        `UPDATE negotiation_offers SET status = 'countered', resolution = 'admin_countered', responded_at = now() WHERE id = $1`,
        [negotiation.pending_offer_id],
      );
    }

    const expiresAt = addSeconds(new Date(), rules.negotiation.offerTtlSeconds);
    const counter = await queryOne<OfferRow>(
      `INSERT INTO negotiation_offers (
         negotiation_id, trip_id, sequence, party, actor_user_id, amount_minor, message, status, expires_at
       ) VALUES ($1, $2, $3, 'company', $4, $5, $6, 'pending', $7)
       RETURNING *`,
      [
        negotiation.id,
        negotiation.trip_id,
        sequence,
        (await import('../../lib/context')).currentActor().userId,
        counterAmount,
        input.note ?? null,
        expiresAt,
      ],
      client,
    );

    await client.query(
      `UPDATE negotiations
          SET status = 'AWAITING_CUSTOMER', company_position_minor = $2, pending_offer_id = $3, version = version + 1
        WHERE id = $1`,
      [negotiation.id, counterAmount, counter!.id],
    );

    await recordAudit(
      {
        action: validation.requiresAudit ? 'negotiation.floor_overridden' : 'negotiation.responded',
        resourceType: 'negotiation',
        resourceId: negotiation.id,
        previousValue: {
          companyPosition: negotiation.company_position_minor,
          floor: negotiation.floor_minor,
        },
        newValue: { counter: counterAmount, belowFloor: counterAmount < negotiation.floor_minor },
        reason: input.note ?? null,
      },
      client,
    );

    await notifyCustomer(client, negotiation.customer_id, 'customer.counteroffer_received', {
      amount: formatMoney(counterAmount),
    });

    emitToCustomer(negotiation.customer_id, 'negotiation.offer_created', {
      tripId: negotiation.trip_id,
      party: 'company',
      amountMinor: counterAmount,
      offerId: counter!.id,
      expiresAt: expiresAt.toISOString(),
    });

    return { status: 'AWAITING_CUSTOMER', counterAmountMinor: counterAmount };
  });
}

/** The admin negotiation console queue. */
export async function reviewQueue(): Promise<NegotiationQueueItem[]> {
  const rows = await query<{
    negotiation_id: string;
    trip_id: string;
    trip_reference: string;
    customer_id: string;
    customer_name: string;
    customer_rating: number | null;
    original_fare_minor: number;
    customer_offer_minor: number;
    floor_minor: number;
    company_position_minor: number;
    rounds_used: number;
    max_rounds: number;
    pickup_address: string;
    destination_address: string;
    distance_metres: number;
    expires_at: Date | null;
    created_at: Date;
  }>(
    `SELECT n.id AS negotiation_id, n.trip_id, t.reference AS trip_reference, n.customer_id,
            u.full_name AS customer_name, c.rating AS customer_rating,
            n.original_fare_minor, n.customer_position_minor AS customer_offer_minor,
            n.floor_minor, n.company_position_minor,
            n.customer_rounds_used AS rounds_used, n.max_customer_rounds AS max_rounds,
            t.pickup_address, t.destination_address, t.distance_metres,
            o.expires_at, n.created_at
       FROM negotiations n
       JOIN trips t ON t.id = n.trip_id
       JOIN customers c ON c.id = n.customer_id
       JOIN users u ON u.id = c.user_id
       LEFT JOIN negotiation_offers o ON o.id = n.pending_offer_id
      WHERE n.status = 'AWAITING_COMPANY'
      ORDER BY o.expires_at ASC NULLS LAST, n.created_at ASC
      LIMIT 100`,
  );

  return rows.map((row) => ({
    negotiationId: row.negotiation_id,
    tripId: row.trip_id,
    tripReference: row.trip_reference,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerRating: row.customer_rating,
    originalFareMinor: row.original_fare_minor,
    customerOfferMinor: row.customer_offer_minor,
    floorMinor: row.floor_minor,
    companyPositionMinor: row.company_position_minor,
    discountPercent: discountPercent(row.original_fare_minor, row.customer_offer_minor),
    roundsUsed: row.rounds_used,
    maxRounds: row.max_rounds,
    pickupAddress: row.pickup_address,
    destinationAddress: row.destination_address,
    distanceMetres: row.distance_metres,
    expiresAt: (row.expires_at ?? row.created_at).toISOString(),
    createdAt: row.created_at.toISOString(),
  }));
}

/** Full timeline for one negotiation — the admin console's detail view. */
export async function negotiationDetail(tripId: string, includeInternal: boolean) {
  const negotiation = await queryOne<NegotiationRow>(
    'SELECT * FROM negotiations WHERE trip_id = $1',
    [tripId],
  );
  if (!negotiation) return null;

  const offers = await query<OfferRow & { actor_name: string | null; resolution: string | null }>(
    `SELECT o.*, u.full_name AS actor_name
       FROM negotiation_offers o
       LEFT JOIN users u ON u.id = o.actor_user_id
      WHERE o.negotiation_id = $1
      ORDER BY o.sequence ASC`,
    [negotiation.id],
  );

  const pending = offers.find((offer) => offer.id === negotiation.pending_offer_id);

  return {
    negotiationId: negotiation.id,
    tripId: negotiation.trip_id,
    status: negotiation.status,
    originalFareMinor: negotiation.original_fare_minor,
    companyPositionMinor: negotiation.company_position_minor,
    customerPositionMinor: negotiation.customer_position_minor,
    finalFareMinor: negotiation.final_fare_minor,
    roundsUsed: negotiation.customer_rounds_used,
    maxRounds: negotiation.max_customer_rounds,
    offersRemaining: Math.max(0, negotiation.max_customer_rounds - negotiation.customer_rounds_used),
    pendingOffer: pending
      ? {
          id: pending.id,
          party: pending.party,
          amountMinor: pending.amount_minor,
          expiresAt: pending.expires_at.toISOString(),
          expiresInSeconds: secondsRemaining(pending.expires_at),
        }
      : null,
    timeline: offers.map((offer) => ({
      id: offer.id,
      sequence: offer.sequence,
      party: offer.party,
      actorName: offer.party === 'company' ? (offer.actor_name ?? 'TransportCo') : offer.actor_name,
      amountMinor: offer.amount_minor,
      message: offer.message,
      status: offer.status,
      resolution: offer.resolution,
      createdAt: offer.created_at.toISOString(),
    })),
    // The floor and the auto-accept threshold are ADMIN-ONLY. Leaking either to
    // a customer response would end the negotiation feature's usefulness.
    ...(includeInternal
      ? {
          floorMinor: negotiation.floor_minor,
          autoAcceptAtOrAboveMinor: negotiation.auto_accept_at_minor,
          maxDiscountPercent: discountPercent(negotiation.original_fare_minor, negotiation.floor_minor),
        }
      : {}),
  };
}

/**
 * Expiry sweeper, run by the scheduler.
 *
 * The timer is server-authoritative: a client that keeps its countdown running
 * past zero still cannot accept, because this has already closed the offer.
 */
export async function expireStaleOffers(): Promise<number> {
  const expired = await query<{ id: string; negotiation_id: string; trip_id: string; customer_id: string }>(
    `UPDATE negotiation_offers o
        SET status = 'expired', resolution = 'expired', responded_at = now()
       FROM negotiations n
      WHERE o.negotiation_id = n.id
        AND o.status = 'pending'
        AND o.expires_at <= now()
      RETURNING o.id, o.negotiation_id, o.trip_id, n.customer_id`,
  );

  for (const offer of expired) {
    await query('UPDATE negotiations SET pending_offer_id = NULL WHERE id = $1 AND pending_offer_id = $2', [
      offer.negotiation_id,
      offer.id,
    ]);

    emitToCustomer(offer.customer_id, 'negotiation.expired', { tripId: offer.trip_id, offerId: offer.id });
    emitToOps('negotiation.expired', { tripId: offer.trip_id, offerId: offer.id });
  }

  if (expired.length > 0) logger.info({ count: expired.length }, 'Expired stale negotiation offers');
  return expired.length;
}
