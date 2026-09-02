import type { FareQuote, Place } from '@transportco/types';
import { addSeconds } from '@transportco/utils';
import { calculateFare } from '../../domain/pricing/engine';
import { getRouteProvider } from '../../services/maps';
import { queryOne } from '../../db/pool';
import { AppError } from '../../lib/errors';
import { OPERATING_TIMEZONE_OFFSET_MINUTES } from '../../config';
import { findZoneForPoint, getActivePricingRuleSet } from './repository';

/**
 * Fare quoting.
 *
 * A quote is the ONLY way a fare enters the system. The customer app posts a
 * pickup and a destination and receives a quote id; creating a trip references
 * that quote. At no point does a client send an amount — which is what makes
 * "never let the client determine the fare" true structurally rather than by
 * convention.
 *
 * Quotes expire. A price computed at 07:55 must not be redeemable at 08:30 when
 * peak pricing has started.
 */

const QUOTE_TTL_SECONDS = 15 * 60;

export interface QuoteRequest {
  customerId: string;
  pickup: Place;
  destination: Place;
  passengers: number;
  scheduledFor: Date | null;
}

export interface QuoteResult {
  quote: FareQuote;
  /** Customer-safe view: the floor and the accept threshold are stripped. */
  customerView: {
    quoteId: string;
    fareMinor: number;
    currency: 'NGN';
    distanceMetres: number;
    durationSeconds: number;
    expiresAt: string;
    negotiable: boolean;
    maxOffers: number;
    breakdown: Array<{ label: string; amountMinor: number }>;
    polyline: string | null;
  };
}

export async function createQuote(request: QuoteRequest): Promise<QuoteResult> {
  const rideAt = request.scheduledFor ?? new Date();

  const zoneId = await findZoneForPoint(request.pickup.latitude, request.pickup.longitude);
  const rules = await getActivePricingRuleSet(zoneId);

  if (request.passengers > rules.maxPassengers) {
    throw new AppError({
      code: 'validation_failed',
      message: `We can carry up to ${rules.maxPassengers} passengers per trip`,
    });
  }

  const route = await getRouteProvider().estimateRoute(
    request.pickup,
    request.destination,
    request.scheduledFor ?? undefined,
  );

  const breakdown = calculateFare(rules, {
    distanceMetres: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    passengers: request.passengers,
    rideAt,
    isScheduled: request.scheduledFor !== null,
    timezoneOffsetMinutes: OPERATING_TIMEZONE_OFFSET_MINUTES,
    zoneId,
  });

  const expiresAt = addSeconds(new Date(), QUOTE_TTL_SECONDS);

  const row = await queryOne<{ id: string; created_at: Date; updated_at: Date }>(
    `INSERT INTO fare_quotes (
       customer_id, status, pickup_lat, pickup_lng, pickup_address, pickup_place_id,
       destination_lat, destination_lng, destination_address, destination_place_id,
       passengers, scheduled_for, distance_metres, duration_seconds, route_provider, route_polyline,
       quoted_fare_minor, floor_minor, auto_accept_at_minor, breakdown,
       pricing_rule_set_id, pricing_version, expires_at
     ) VALUES ($1,'active',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id, created_at, updated_at`,
    [
      request.customerId,
      request.pickup.latitude,
      request.pickup.longitude,
      request.pickup.address,
      request.pickup.placeId ?? null,
      request.destination.latitude,
      request.destination.longitude,
      request.destination.address,
      request.destination.placeId ?? null,
      request.passengers,
      request.scheduledFor,
      breakdown.distanceMetres,
      breakdown.durationSeconds,
      route.provider,
      route.polyline,
      breakdown.totalMinor,
      breakdown.floorMinor,
      breakdown.autoAcceptAtOrAboveMinor,
      JSON.stringify(breakdown),
      rules.id,
      rules.version,
      expiresAt,
    ],
  );

  const quote: FareQuote = {
    id: row!.id,
    customerId: request.customerId,
    status: 'active',
    pickup: {
      latitude: request.pickup.latitude,
      longitude: request.pickup.longitude,
      address: request.pickup.address,
    },
    destination: {
      latitude: request.destination.latitude,
      longitude: request.destination.longitude,
      address: request.destination.address,
    },
    passengers: request.passengers,
    scheduledFor: request.scheduledFor?.toISOString() ?? null,
    route,
    breakdown,
    expiresAt: expiresAt.toISOString(),
    createdAt: row!.created_at.toISOString(),
    updatedAt: row!.updated_at.toISOString(),
  };

  return {
    quote,
    customerView: {
      quoteId: quote.id,
      fareMinor: breakdown.totalMinor,
      currency: breakdown.currency,
      distanceMetres: breakdown.distanceMetres,
      durationSeconds: breakdown.durationSeconds,
      expiresAt: quote.expiresAt,
      negotiable: rules.negotiation.enabled,
      maxOffers: rules.negotiation.maxCustomerRounds,
      // The customer sees WHAT they are paying for, not the internal thresholds.
      breakdown: breakdown.components
        .filter((component) => component.amountMinor !== 0)
        .map((component) => ({ label: component.label, amountMinor: component.amountMinor })),
      polyline: route.polyline ?? null,
    },
  };
}

export interface StoredQuote {
  id: string;
  customer_id: string;
  status: string;
  pickup_lat: number;
  pickup_lng: number;
  pickup_address: string;
  pickup_place_id: string | null;
  destination_lat: number;
  destination_lng: number;
  destination_address: string;
  destination_place_id: string | null;
  passengers: number;
  scheduled_for: Date | null;
  distance_metres: number;
  duration_seconds: number;
  route_provider: string;
  route_polyline: string | null;
  quoted_fare_minor: number;
  floor_minor: number;
  auto_accept_at_minor: number;
  breakdown: unknown;
  pricing_rule_set_id: string;
  pricing_version: number;
  expires_at: Date;
}

/**
 * Loads a quote for consumption, enforcing ownership and expiry. Called inside
 * the trip-creation transaction so a quote cannot be spent twice.
 */
export async function consumeQuote(
  quoteId: string,
  customerId: string,
  client?: Parameters<typeof queryOne>[2],
): Promise<StoredQuote> {
  const quote = await queryOne<StoredQuote>(
    'SELECT * FROM fare_quotes WHERE id = $1 FOR UPDATE',
    [quoteId],
    client,
  );

  if (!quote) throw new AppError({ code: 'not_found', message: 'That fare quote no longer exists' });

  // Ownership is checked server-side: a quote id is not a capability.
  if (quote.customer_id !== customerId) {
    throw new AppError({ code: 'forbidden', message: 'That fare quote belongs to another account' });
  }

  if (quote.status === 'consumed') {
    throw new AppError({ code: 'conflict', message: 'A trip was already created from this fare' });
  }

  if (quote.status !== 'active' || quote.expires_at.getTime() <= Date.now()) {
    throw new AppError({
      code: 'quote_expired',
      message: 'That fare has expired. Please get a new price.',
    });
  }

  return quote;
}
