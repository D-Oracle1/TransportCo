import { z } from 'zod';
import {
  emailSchema,
  freeTextSchema,
  fullNameSchema,
  isoDateTimeSchema,
  latitudeSchema,
  longitudeSchema,
  minorAmountSchema,
  otpSchema,
  passwordSchema,
  phoneSchema,
  placeSchema,
  positiveMinorAmountSchema,
  uuidSchema,
} from './primitives';

// --- Auth ------------------------------------------------------------------

export const registerCustomerSchema = z.object({
  fullName: fullNameSchema,
  phone: phoneSchema,
  email: emailSchema.optional(),
  password: passwordSchema,
  /** Optional at sign-up. We never ask for a card here — deliberate trust decision. */
  referralCode: z.string().trim().min(4).max(12).optional(),
});

export const loginSchema = z.object({
  /** Phone or email. Customers overwhelmingly use phone in this market. */
  identifier: z.string().trim().min(3).max(255),
  password: z.string().min(1, 'Enter your password').max(128),
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: otpSchema,
  purpose: z.enum(['phone_verification', 'password_reset', 'login']),
});

export const requestOtpSchema = z.object({
  phone: phoneSchema,
  purpose: z.enum(['phone_verification', 'password_reset', 'login']),
});

export const forgotPasswordSchema = z.object({ phone: phoneSchema });

export const resetPasswordSchema = z.object({
  phone: phoneSchema,
  code: otpSchema,
  newPassword: passwordSchema,
});

export const refreshTokenSchema = z.object({ refreshToken: z.string().min(20) });

export const registerPushTokenSchema = z.object({
  token: z.string().min(10).max(255),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().max(128).optional(),
});

// --- Booking ---------------------------------------------------------------

export const fareEstimateSchema = z
  .object({
    pickup: placeSchema,
    destination: placeSchema,
    passengers: z.number().int().min(1).max(6).default(1),
    scheduledFor: isoDateTimeSchema.nullish(),
  })
  .refine(
    (value) =>
      value.pickup.latitude !== value.destination.latitude ||
      value.pickup.longitude !== value.destination.longitude,
    { message: 'Pickup and destination must be different', path: ['destination'] },
  )
  .refine(
    (value) => !value.scheduledFor || new Date(value.scheduledFor).getTime() > Date.now() + 10 * 60_000,
    { message: 'Scheduled pickup must be at least 10 minutes away', path: ['scheduledFor'] },
  );

export const createTripSchema = z.object({
  /** The server re-prices from this quote; the client never sends a fare. */
  quoteId: uuidSchema,
  paymentMethod: z.enum(['cash', 'card', 'bank_transfer']).default('cash'),
  specialInstructions: freeTextSchema(300).optional(),
});

export const cancelTripSchema = z.object({
  reason: z.enum([
    'changed_plans',
    'driver_taking_too_long',
    'wrong_address',
    'found_another_ride',
    'fare_too_high',
    'safety_concern',
    'other',
  ]),
  note: freeTextSchema(300).optional(),
});

// --- Negotiation -----------------------------------------------------------

export const customerOfferSchema = z.object({
  /** Minor units. The server validates it against the floor it alone knows. */
  amountMinor: positiveMinorAmountSchema,
  message: freeTextSchema(200).optional(),
});

export const adminNegotiationResponseSchema = z
  .object({
    action: z.enum(['accept', 'reject', 'counter']),
    counterAmountMinor: positiveMinorAmountSchema.optional(),
    /** Required when countering below the configured floor. Audited. */
    overrideFloor: z.boolean().default(false),
    note: freeTextSchema(300).optional(),
  })
  .refine((value) => value.action !== 'counter' || value.counterAmountMinor !== undefined, {
    message: 'A counteroffer needs an amount',
    path: ['counterAmountMinor'],
  });

export const acceptFareSchema = z.object({
  /** Guards against accepting a stale offer the customer saw before a counter. */
  offerId: uuidSchema,
});

// --- Dispatch --------------------------------------------------------------

export const assignDriverSchema = z.object({
  driverId: uuidSchema,
  reason: z
    .enum([
      'initial_assignment',
      'admin_override',
      'driver_unavailable',
      'driver_no_show',
      'schedule_conflict',
      'customer_request',
      'system_reassignment',
    ])
    .default('initial_assignment'),
  note: freeTextSchema(300).optional(),
  /** Optimistic concurrency: rejected if another admin moved first. */
  expectedVersion: z.number().int().nonnegative().optional(),
});

// --- Driver ----------------------------------------------------------------

export const driverStateSchema = z.object({
  state: z.enum(['OFFLINE', 'ONLINE', 'AVAILABLE', 'ON_BREAK']),
});

export const driverLocationSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  headingDegrees: z.number().min(0).max(360).nullish(),
  speedMetresPerSecond: z.number().min(0).max(90).nullish(),
  accuracyMetres: z.number().min(0).max(10_000).nullish(),
  recordedAt: isoDateTimeSchema,
  tripId: uuidSchema.nullish(),
});

/** Offline queue flush: a batch of fixes recorded while the driver had no signal. */
export const driverLocationBatchSchema = z.object({
  points: z.array(driverLocationSchema).min(1).max(200),
});

export const driverTripActionSchema = z.object({
  action: z.enum(['start_pickup', 'arrived', 'start_trip', 'complete_trip', 'report_no_show']),
  /** Location at the moment of the action — used to verify the driver was there. */
  latitude: latitudeSchema.optional(),
  longitude: longitudeSchema.optional(),
  note: freeTextSchema(300).optional(),
  /** Client-generated, so a retry after a dropped connection is not a double action. */
  idempotencyKey: z.string().uuid().optional(),
});

export const cashCollectionSchema = z.object({
  /** Must equal the locked fare. The server rejects any other amount. */
  amountMinor: positiveMinorAmountSchema,
  idempotencyKey: z.string().uuid().optional(),
});

// --- Payments --------------------------------------------------------------

export const initializePaymentSchema = z.object({
  tripId: uuidSchema.optional(),
  purpose: z.enum(['trip_fare', 'cancellation_fee', 'no_show_fee', 'outstanding_balance']).default('trip_fare'),
  method: z.enum(['card', 'bank_transfer', 'cash']),
  provider: z.enum(['paystack', 'flutterwave']).optional(),
  /** Points the customer wants to burn on this fare. Server caps it by policy. */
  redeemPoints: z.number().int().min(0).optional(),
});

export const verifyPaymentSchema = z.object({
  paymentId: uuidSchema,
  providerReference: z.string().min(3).max(255).optional(),
});

export const refundSchema = z.object({
  paymentId: uuidSchema,
  amountMinor: positiveMinorAmountSchema,
  reason: freeTextSchema(300).min(5, 'Give a reason — refunds are audited'),
});

// --- Engagement ------------------------------------------------------------

export const reviewSchema = z.object({
  driverRating: z.number().int().min(1).max(5),
  serviceRating: z.number().int().min(1).max(5).optional(),
  comment: freeTextSchema(500).optional(),
  tags: z.array(z.string().max(40)).max(6).optional(),
});

export const supportTicketSchema = z.object({
  category: z.enum([
    'driver_did_not_arrive',
    'driver_issue',
    'payment_problem',
    'incorrect_charge',
    'lost_item',
    'trip_issue',
    'cancellation',
    'safety_issue',
    'other',
  ]),
  subject: z.string().trim().min(4).max(140),
  message: freeTextSchema(2000).min(10, 'Tell us a little more'),
  tripId: uuidSchema.nullish(),
});

export const supportMessageSchema = z.object({
  body: freeTextSchema(2000).min(1),
  internal: z.boolean().default(false),
  attachments: z.array(z.string().url()).max(5).optional(),
});

export const sosSchema = z.object({
  type: z.enum(['sos', 'accident', 'harassment', 'vehicle_breakdown', 'medical', 'other']).default('sos'),
  tripId: uuidSchema.nullish(),
  latitude: latitudeSchema.nullish(),
  longitude: longitudeSchema.nullish(),
  note: freeTextSchema(500).optional(),
});

export const savedLocationSchema = z.object({
  label: z.string().trim().min(1).max(60),
  kind: z.enum(['home', 'work', 'other']).default('other'),
  address: z.string().trim().min(3).max(255),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  placeId: z.string().max(255).nullish(),
});

// --- Admin: pricing --------------------------------------------------------

const timeWindowSchema = z.object({
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
});

const multiplierRuleSchema = z.object({
  code: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  enabled: z.boolean(),
  multiplier: z.number().min(0.5).max(3),
  windows: z.array(timeWindowSchema).max(10),
});

export const pricingRuleSetSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    zoneId: uuidSchema.nullish(),
    effectiveFrom: isoDateTimeSchema,
    baseFareMinor: minorAmountSchema,
    perKilometreMinor: minorAmountSchema,
    perMinuteMinor: minorAmountSchema,
    minimumFareMinor: minorAmountSchema,
    maximumFareMinor: minorAmountSchema.nullish(),
    roundToNearestMinor: minorAmountSchema,
    includedPassengers: z.number().int().min(1).max(6),
    extraPassengerFeeMinor: minorAmountSchema,
    maxPassengers: z.number().int().min(1).max(8),
    longDistanceThresholdMetres: z.number().int().min(0),
    longDistancePerKilometreMinor: minorAmountSchema,
    scheduledRideMultiplier: z.number().min(0.5).max(3),
    demandMultiplier: z.number().min(0.5).max(3),
    demandMultiplierMax: z.number().min(1).max(3),
    peak: multiplierRuleSchema,
    night: multiplierRuleSchema,
    weekend: multiplierRuleSchema,
    publicHoliday: multiplierRuleSchema,
    publicHolidayDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60),
    negotiation: z.object({
      enabled: z.boolean(),
      maxDiscountPercent: z.number().min(0).max(60),
      autoAcceptDiscountPercent: z.number().min(0).max(60),
      adminReviewEnabled: z.boolean(),
      maxCustomerRounds: z.number().int().min(0).max(5),
      offerTtlSeconds: z.number().int().min(60).max(3600),
      autoCounterMeetRatio: z.number().min(0).max(1),
    }),
    cancellation: z.object({
      gracePeriodSeconds: z.number().int().min(0).max(1800),
      afterAssignmentFeeMinor: minorAmountSchema,
      driverEnRouteFeeMinor: minorAmountSchema,
      driverArrivedFeeMinor: minorAmountSchema,
      noShowFeeMinor: minorAmountSchema,
      noShowWaitSeconds: z.number().int().min(60).max(3600),
      scheduledLateCancelWindowSeconds: z.number().int().min(0).max(86_400),
      blockNewTripsAboveOutstandingMinor: minorAmountSchema,
    }),
    loyalty: z.object({
      enabled: z.boolean(),
      pointsPerSpendUnitMinor: positiveMinorAmountSchema,
      pointsPerUnit: z.number().min(0).max(1000),
      pointValueMinor: minorAmountSchema,
      maxRedemptionPercentOfFare: z.number().min(0).max(100),
      minimumRedeemablePoints: z.number().int().min(0),
      pointsExpiryDays: z.number().int().min(1).max(3650).nullish(),
    }),
    costModel: z.object({
      fuelOrEnergyCostPerKmMinor: minorAmountSchema,
      driverVariableCostPerTripMinor: minorAmountSchema,
      operationalOverheadPerTripMinor: minorAmountSchema,
      paymentFeePercent: z.number().min(0).max(10),
      paymentFeeFlatMinor: minorAmountSchema,
      paymentFeeCapMinor: minorAmountSchema.nullish(),
    }),
    changeNote: freeTextSchema(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.negotiation.autoAcceptDiscountPercent > value.negotiation.maxDiscountPercent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['negotiation', 'autoAcceptDiscountPercent'],
        message: 'Auto-accept discount cannot be deeper than the maximum discount',
      });
    }
    if (value.maximumFareMinor != null && value.maximumFareMinor < value.minimumFareMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maximumFareMinor'],
        message: 'Maximum fare cannot be below the minimum fare',
      });
    }
    if (value.demandMultiplier > value.demandMultiplierMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['demandMultiplier'],
        message: 'Demand multiplier exceeds its configured ceiling',
      });
    }
  });

// --- Admin: people ---------------------------------------------------------

export const createDriverSchema = z.object({
  fullName: fullNameSchema,
  phone: phoneSchema,
  email: emailSchema.optional(),
  employeeId: z.string().trim().min(3).max(30).optional(),
  jobTitle: z.string().trim().min(2).max(80).default('Driver'),
  employmentDate: isoDateTimeSchema,
  basicSalaryMinor: minorAmountSchema,
  licenseNumber: z.string().trim().min(4).max(40),
  licenseExpiry: isoDateTimeSchema,
  licenseClass: z.string().trim().max(10).optional(),
  assignedVehicleId: uuidSchema.nullish(),
  temporaryPassword: passwordSchema.optional(),
});

export const suspendCustomerSchema = z.object({
  reason: freeTextSchema(300).min(5, 'Give a reason — suspensions are audited'),
});

export const loyaltyAdjustmentSchema = z.object({
  customerId: uuidSchema,
  points: z.number().int().refine((value) => value !== 0, 'Adjustment cannot be zero'),
  reason: freeTextSchema(300).min(5, 'Give a reason — loyalty adjustments are audited'),
});

export const payrollItemSchema = z.object({
  type: z.enum(['basic_salary', 'allowance', 'bonus', 'overtime', 'deduction', 'penalty']),
  label: z.string().trim().min(2).max(80),
  amountMinor: positiveMinorAmountSchema,
  quantity: z.number().min(0).max(1000).nullish(),
  note: freeTextSchema(300).optional(),
});

export const assignRolesSchema = z.object({
  roleKeys: z.array(z.string().min(2).max(40)).min(1).max(6),
  reason: freeTextSchema(300).optional(),
});
