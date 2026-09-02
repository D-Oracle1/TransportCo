import type { DispatchWeights, PricingRuleSet } from '@transportco/types';

/**
 * Launch defaults for Rivers State.
 *
 * These are SEED values only. Once the platform is running, pricing lives in
 * the database and is edited through the admin console — nothing here is read
 * at request time. Changing a number in this file affects a fresh install and
 * nothing else.
 *
 * Money is in kobo: 70_000 === ₦700.
 */
export type SeedPricingRuleSet = Omit<
  PricingRuleSet,
  'id' | 'createdAt' | 'updatedAt' | 'createdByUserId' | 'publishedByUserId' | 'publishedAt' | 'zoneId' | 'effectiveFrom' | 'effectiveTo' | 'status' | 'version'
>;

export const DEFAULT_PRICING_RULE_SET: SeedPricingRuleSet = {
  name: 'Rivers State — launch pricing',
  currency: 'NGN',

  baseFareMinor: 70_000, // ₦700 flag-down
  perKilometreMinor: 18_000, // ₦180/km
  perMinuteMinor: 2_500, // ₦25/min
  minimumFareMinor: 120_000, // ₦1,200 — no trip is worth dispatching below this
  maximumFareMinor: null,
  roundToNearestMinor: 5_000, // quote in clean ₦50 steps

  includedPassengers: 3,
  extraPassengerFeeMinor: 20_000, // ₦200 per passenger beyond three
  maxPassengers: 6,

  longDistanceThresholdMetres: 30_000,
  longDistancePerKilometreMinor: 14_000, // ₦140/km beyond 30 km (fuel efficiency improves on highway)

  scheduledRideMultiplier: 1.05,
  demandMultiplier: 1.0,
  demandMultiplierMax: 1.8, // a fat finger cannot triple every fare in the city

  peak: {
    code: 'peak',
    label: 'Peak hours',
    enabled: true,
    multiplier: 1.2,
    windows: [
      { startMinute: 6 * 60 + 30, endMinute: 9 * 60 + 30, weekdays: [1, 2, 3, 4, 5] },
      { startMinute: 16 * 60 + 30, endMinute: 19 * 60 + 30, weekdays: [1, 2, 3, 4, 5] },
    ],
  },

  night: {
    code: 'night',
    label: 'Night rate',
    enabled: true,
    multiplier: 1.15,
    windows: [{ startMinute: 22 * 60, endMinute: 5 * 60 }], // wraps midnight
  },

  weekend: {
    code: 'weekend',
    label: 'Weekend',
    enabled: true,
    multiplier: 1.1,
    windows: [{ startMinute: 0, endMinute: 24 * 60, weekdays: [0, 6] }],
  },

  publicHoliday: {
    code: 'public_holiday',
    label: 'Public holiday',
    enabled: true,
    multiplier: 1.25,
    windows: [{ startMinute: 0, endMinute: 24 * 60 }],
  },

  publicHolidayDates: [
    '2026-01-01', // New Year's Day
    '2026-10-01', // Independence Day
    '2026-12-25', // Christmas Day
    '2026-12-26', // Boxing Day
  ],

  negotiation: {
    enabled: true,
    /** Never go below 15% off the quote. This is the company's hard floor. */
    maxDiscountPercent: 15,
    /** Anything within 5% of the quote is accepted instantly, no human needed. */
    autoAcceptDiscountPercent: 5,
    adminReviewEnabled: true,
    maxCustomerRounds: 2,
    offerTtlSeconds: 300,
    /** System counters halfway between its position and the customer's offer. */
    autoCounterMeetRatio: 0.5,
  },

  cancellation: {
    gracePeriodSeconds: 120,
    afterAssignmentFeeMinor: 50_000, // ₦500
    driverEnRouteFeeMinor: 80_000, // ₦800
    driverArrivedFeeMinor: 120_000, // ₦1,200
    noShowFeeMinor: 150_000, // ₦1,500
    noShowWaitSeconds: 300,
    scheduledLateCancelWindowSeconds: 3_600,
    /** Above ₦1,000 owed, new ride requests are blocked until it is settled. */
    blockNewTripsAboveOutstandingMinor: 100_000,
  },

  loyalty: {
    enabled: true,
    pointsPerSpendUnitMinor: 100_000, // per ₦1,000 spent
    pointsPerUnit: 10, // ...award 10 points
    pointValueMinor: 100, // each point is worth ₦1 (1% effective return)
    maxRedemptionPercentOfFare: 50,
    minimumRedeemablePoints: 500,
    pointsExpiryDays: 365,
  },

  costModel: {
    fuelOrEnergyCostPerKmMinor: 9_000, // ₦90/km at launch fuel prices
    driverVariableCostPerTripMinor: 15_000, // ₦150
    operationalOverheadPerTripMinor: 20_000, // ₦200
    paymentFeePercent: 1.5,
    paymentFeeFlatMinor: 10_000, // ₦100
    paymentFeeCapMinor: 200_000, // ₦2,000 cap, mirroring local provider terms
  },

  changeNote: 'Initial seeded pricing for the Rivers State pilot.',
};

/**
 * Dispatch weighting. Proximity matters most, but not so much that the nearest
 * driver always wins regardless of how loaded they are — that is exactly the
 * behaviour the brief calls out as wrong.
 */
export const DEFAULT_DISPATCH_WEIGHTS: DispatchWeights = {
  proximity: 0.45,
  workload: 0.25,
  rating: 0.15,
  idleTime: 0.15,
  vehicleReadiness: 0.0, // reserved for the EV fleet
};

/** Operational limits that are not pricing but still must not be hardcoded in screens. */
export const OPERATIONS_DEFAULTS = {
  /** A driver location older than this is treated as stale by dispatch. */
  staleLocationSeconds: 120,
  /** Maximum straight-line pickup radius considered for a recommendation. */
  maxPickupRadiusMetres: 25_000,
  /** Scheduled rides are handed to the driver this long before pickup. */
  scheduledDispatchLeadSeconds: 1_800,
  /** Reminder to customer and driver before a scheduled pickup. */
  scheduledReminderLeadSeconds: 3_600,
  /** Location ping cadence by driver state, in seconds. Battery-conscious. */
  locationPingSeconds: {
    AVAILABLE: 45,
    ASSIGNED: 20,
    PICKING_UP: 10,
    ARRIVED: 30,
    ON_TRIP: 10,
    IDLE: 120,
  },
  /** Straight-line speed above this between two fixes flags possible spoofing. */
  gpsImplausibleSpeedMps: 55, // ~200 km/h
} as const;
