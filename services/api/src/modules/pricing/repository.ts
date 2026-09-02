import type { PoolClient } from 'pg';
import type { PricingRuleSet } from '@transportco/types';
import { queryOne, query } from '../../db/pool';
import { AppError } from '../../lib/errors';

/**
 * Pricing persistence.
 *
 * Rows map to the `PricingRuleSet` domain type here and nowhere else, so the
 * pricing engine never sees a snake_case database row and the rest of the
 * codebase never sees SQL.
 */

export interface PricingRow {
  id: string;
  version: number;
  name: string;
  status: 'draft' | 'published' | 'archived';
  currency: 'NGN';
  zone_id: string | null;
  effective_from: Date;
  effective_to: Date | null;
  base_fare_minor: number;
  per_kilometre_minor: number;
  per_minute_minor: number;
  minimum_fare_minor: number;
  maximum_fare_minor: number | null;
  round_to_nearest_minor: number;
  included_passengers: number;
  extra_passenger_fee_minor: number;
  max_passengers: number;
  long_distance_threshold_metres: number;
  long_distance_per_km_minor: number;
  scheduled_ride_multiplier: number;
  demand_multiplier: number;
  demand_multiplier_max: number;
  peak: PricingRuleSet['peak'];
  night: PricingRuleSet['night'];
  weekend: PricingRuleSet['weekend'];
  public_holiday: PricingRuleSet['publicHoliday'];
  public_holiday_dates: string[];
  negotiation: PricingRuleSet['negotiation'];
  cancellation: PricingRuleSet['cancellation'];
  loyalty: PricingRuleSet['loyalty'];
  cost_model: PricingRuleSet['costModel'];
  created_by_user_id: string | null;
  published_by_user_id: string | null;
  published_at: Date | null;
  change_note: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toPricingRuleSet(row: PricingRow): PricingRuleSet {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    status: row.status,
    currency: row.currency,
    zoneId: row.zone_id,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to?.toISOString() ?? null,
    baseFareMinor: row.base_fare_minor,
    perKilometreMinor: row.per_kilometre_minor,
    perMinuteMinor: row.per_minute_minor,
    minimumFareMinor: row.minimum_fare_minor,
    maximumFareMinor: row.maximum_fare_minor,
    roundToNearestMinor: row.round_to_nearest_minor,
    includedPassengers: row.included_passengers,
    extraPassengerFeeMinor: row.extra_passenger_fee_minor,
    maxPassengers: row.max_passengers,
    longDistanceThresholdMetres: row.long_distance_threshold_metres,
    longDistancePerKilometreMinor: row.long_distance_per_km_minor,
    scheduledRideMultiplier: Number(row.scheduled_ride_multiplier),
    demandMultiplier: Number(row.demand_multiplier),
    demandMultiplierMax: Number(row.demand_multiplier_max),
    peak: row.peak,
    night: row.night,
    weekend: row.weekend,
    publicHoliday: row.public_holiday,
    publicHolidayDates: row.public_holiday_dates,
    negotiation: row.negotiation,
    cancellation: row.cancellation,
    loyalty: row.loyalty,
    costModel: row.cost_model,
    createdByUserId: row.created_by_user_id,
    publishedByUserId: row.published_by_user_id,
    publishedAt: row.published_at?.toISOString() ?? null,
    changeNote: row.change_note,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The rule set in force right now.
 *
 * A zone-specific published set wins over the platform default. There can only
 * be one published set per zone — the database enforces that with a partial
 * unique index, because two live price lists would silently produce two
 * different fares for the same trip.
 */
export async function getActivePricingRuleSet(zoneId?: string | null): Promise<PricingRuleSet> {
  const row = await queryOne<PricingRow>(
    `SELECT * FROM pricing_rule_sets
      WHERE status = 'published'
        AND effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())
        AND (zone_id = $1 OR zone_id IS NULL)
      ORDER BY (zone_id = $1) DESC NULLS LAST, version DESC
      LIMIT 1`,
    [zoneId ?? null],
  );

  if (!row) {
    // Refusing to invent a fallback price is deliberate: quoting from a
    // hardcoded default would mean charging a customer a price no one approved.
    throw new AppError({
      code: 'internal_error',
      message: 'Pricing is not available right now. Please try again shortly.',
      logContext: { reason: 'no_published_pricing_rule_set', zoneId },
    });
  }

  return toPricingRuleSet(row);
}

/**
 * The exact rule set that priced a historical trip. Never falls back to the
 * current one — that would rewrite history.
 */
export async function getPricingRuleSetById(id: string): Promise<PricingRuleSet> {
  const row = await queryOne<PricingRow>('SELECT * FROM pricing_rule_sets WHERE id = $1', [id]);
  if (!row) throw new AppError({ code: 'not_found', message: 'Pricing rule set not found' });
  return toPricingRuleSet(row);
}

export async function listPricingRuleSets(): Promise<PricingRuleSet[]> {
  const rows = await query<PricingRow>(
    'SELECT * FROM pricing_rule_sets ORDER BY zone_id NULLS FIRST, version DESC',
  );
  return rows.map(toPricingRuleSet);
}

export async function nextVersionFor(zoneId: string | null, client?: PoolClient): Promise<number> {
  const row = await queryOne<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next
       FROM pricing_rule_sets
      WHERE zone_id IS NOT DISTINCT FROM $1`,
    [zoneId],
    client,
  );
  return row?.next ?? 1;
}

/** Finds the operating zone containing a point, if any. */
export async function findZoneForPoint(latitude: number, longitude: number): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM zones
      WHERE active
        AND (6371000 * acos(
              LEAST(1, cos(radians($1)) * cos(radians(centre_lat)) *
                       cos(radians(centre_lng) - radians($2)) +
                       sin(radians($1)) * sin(radians(centre_lat)))
            )) <= radius_metres
      ORDER BY radius_metres ASC
      LIMIT 1`,
    [latitude, longitude],
  );
  return row?.id ?? null;
}
