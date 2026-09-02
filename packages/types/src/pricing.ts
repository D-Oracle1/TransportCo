import type { CurrencyCode, ISODateTime, MinorUnits, RouteEstimate, Timestamps, UUID } from './common';

/**
 * Pricing is configuration, not code.
 *
 * A `PricingRuleSet` is an immutable, versioned document. Publishing a change
 * creates a NEW version; the old one is archived, never edited. Every fare
 * quote stores the `pricingRuleSetId` + `pricingVersion` that produced it, so a
 * completed trip can always be re-derived exactly as it was priced.
 */

export type PricingRuleSetStatus = 'draft' | 'published' | 'archived';

/** Day-of-week in the operating timezone. 0 = Sunday .. 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface TimeWindow {
  /** Minutes from local midnight, inclusive. */
  startMinute: number;
  /** Minutes from local midnight, exclusive. Windows may wrap past midnight. */
  endMinute: number;
  /** Empty means "every day". */
  weekdays?: Weekday[];
}

export interface MultiplierRule {
  code: string;
  label: string;
  enabled: boolean;
  /** 1.0 = no change. 1.25 = +25%. */
  multiplier: number;
  windows: TimeWindow[];
}

export interface NegotiationPolicy {
  enabled: boolean;
  /** Hard floor: the deepest discount the company will ever accept, in percent of the quoted fare. */
  maxDiscountPercent: number;
  /**
   * Offers at or above (quote * (1 - autoAcceptDiscountPercent/100)) are accepted
   * by the system with no human involved.
   */
  autoAcceptDiscountPercent: number;
  /**
   * Offers between the auto-accept band and the hard floor go to a human.
   * Below the floor the system auto-rejects.
   */
  adminReviewEnabled: boolean;
  /** How many offers the CUSTOMER may submit per trip. Admin counters are not capped by this. */
  maxCustomerRounds: number;
  /** Server-authoritative lifetime of any pending offer. */
  offerTtlSeconds: number;
  /**
   * When the system counters automatically (no dispatcher online), it meets the
   * customer this far between its last position and their offer. 0 disables auto-counter.
   */
  autoCounterMeetRatio: number;
}

export interface CancellationPolicy {
  /** Free-cancellation grace period after the fare is locked. */
  gracePeriodSeconds: number;
  /** Fee once a driver is assigned but has not yet departed. */
  afterAssignmentFeeMinor: MinorUnits;
  /** Fee once the driver is en route. */
  driverEnRouteFeeMinor: MinorUnits;
  /** Fee once the driver has arrived at pickup. */
  driverArrivedFeeMinor: MinorUnits;
  /** Fee when the customer never shows after the wait window elapses. */
  noShowFeeMinor: MinorUnits;
  /** How long a driver waits at pickup before no-show may be declared. */
  noShowWaitSeconds: number;
  /** Scheduled rides cancelled within this window of pickup incur the assignment fee. */
  scheduledLateCancelWindowSeconds: number;
  /** Block new ride requests while an unpaid balance exceeds this amount. 0 = never block. */
  blockNewTripsAboveOutstandingMinor: MinorUnits;
}

export interface LoyaltyPolicy {
  enabled: boolean;
  /** Points granted per this many minor units spent. Default: 10 points per ₦1,000. */
  pointsPerSpendUnitMinor: MinorUnits;
  pointsPerUnit: number;
  /** Value of one point when redeemed, in minor units. */
  pointValueMinor: MinorUnits;
  /** Redemption may not cover more than this share of a fare. */
  maxRedemptionPercentOfFare: number;
  minimumRedeemablePoints: number;
  pointsExpiryDays: number | null;
}

/**
 * Unit economics inputs. Not customer-facing — these feed contribution margin
 * reporting so management can see whether negotiation is helping or hurting.
 */
export interface CostModel {
  fuelOrEnergyCostPerKmMinor: MinorUnits;
  driverVariableCostPerTripMinor: MinorUnits;
  operationalOverheadPerTripMinor: MinorUnits;
  /** Provider fee, e.g. 1.5 means 1.5%. */
  paymentFeePercent: number;
  paymentFeeFlatMinor: MinorUnits;
  paymentFeeCapMinor: MinorUnits | null;
}

export interface PricingRuleSet extends Timestamps {
  id: UUID;
  /** Monotonic per zone. Version 1 is the first published set. */
  version: number;
  name: string;
  status: PricingRuleSetStatus;
  currency: CurrencyCode;
  /** null = platform default, applied when no zone-specific set matches. */
  zoneId: UUID | null;
  effectiveFrom: ISODateTime;
  effectiveTo: ISODateTime | null;

  baseFareMinor: MinorUnits;
  perKilometreMinor: MinorUnits;
  perMinuteMinor: MinorUnits;
  minimumFareMinor: MinorUnits;
  maximumFareMinor: MinorUnits | null;
  /** Fares are rounded UP to this increment so customers see clean numbers. 0 disables. */
  roundToNearestMinor: MinorUnits;

  /** Passengers included in the base fare; each extra passenger adds a fee. */
  includedPassengers: number;
  extraPassengerFeeMinor: MinorUnits;
  maxPassengers: number;

  /** Distance beyond this threshold is charged at the long-distance rate instead. */
  longDistanceThresholdMetres: number;
  longDistancePerKilometreMinor: MinorUnits;

  scheduledRideMultiplier: number;
  /**
   * Operations-controlled demand dial (surge). Bounded so a fat finger cannot
   * triple every fare in the city.
   */
  demandMultiplier: number;
  demandMultiplierMax: number;

  peak: MultiplierRule;
  night: MultiplierRule;
  weekend: MultiplierRule;
  publicHoliday: MultiplierRule;
  /** ISO dates (YYYY-MM-DD) treated as public holidays. */
  publicHolidayDates: string[];

  negotiation: NegotiationPolicy;
  cancellation: CancellationPolicy;
  loyalty: LoyaltyPolicy;
  costModel: CostModel;

  createdByUserId: UUID | null;
  publishedByUserId: UUID | null;
  publishedAt: ISODateTime | null;
  changeNote: string | null;
}

/** A single named line in the fare breakdown shown to customers and ops. */
export interface FareComponent {
  code:
    | 'base_fare'
    | 'distance'
    | 'long_distance'
    | 'duration'
    | 'extra_passengers'
    | 'peak'
    | 'night'
    | 'weekend'
    | 'public_holiday'
    | 'demand'
    | 'scheduled'
    | 'zone'
    | 'minimum_fare_adjustment'
    | 'maximum_fare_adjustment'
    | 'rounding';
  label: string;
  /** Signed minor units. Multiplier rules contribute the delta they added. */
  amountMinor: MinorUnits;
  /** Present for multiplicative rules, for explainability in the admin console. */
  multiplier?: number;
}

export interface FareBreakdown {
  currency: CurrencyCode;
  components: FareComponent[];
  /** Sum of components before floor/ceiling/rounding. */
  subtotalMinor: MinorUnits;
  /** Final quoted fare after minimum, maximum and rounding. */
  totalMinor: MinorUnits;
  /** Lowest fare the company will accept for this trip (the negotiation floor). */
  floorMinor: MinorUnits;
  /** Offers at or above this are auto-accepted. */
  autoAcceptAtOrAboveMinor: MinorUnits;
  distanceMetres: number;
  durationSeconds: number;
  pricingRuleSetId: UUID;
  pricingVersion: number;
}

export type FareQuoteStatus = 'active' | 'expired' | 'consumed' | 'superseded';

/**
 * A quote is a priced, time-boxed offer. Trips reference the quote they were
 * created from; the quote snapshot is immutable so history never drifts.
 */
export interface FareQuote extends Timestamps {
  id: UUID;
  customerId: UUID;
  status: FareQuoteStatus;
  pickup: { latitude: number; longitude: number; address: string };
  destination: { latitude: number; longitude: number; address: string };
  passengers: number;
  scheduledFor: ISODateTime | null;
  route: RouteEstimate;
  breakdown: FareBreakdown;
  expiresAt: ISODateTime;
}

/** Inputs the pricing engine needs. Nothing here comes from the client untrusted. */
export interface FareCalculationInput {
  distanceMetres: number;
  durationSeconds: number;
  passengers: number;
  /** The moment the ride happens (now, or the scheduled pickup time). */
  rideAt: Date;
  isScheduled: boolean;
  /** Operating timezone offset in minutes, e.g. +60 for West Africa Time. */
  timezoneOffsetMinutes: number;
  zoneId?: UUID | null;
}
