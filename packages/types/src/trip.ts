import type { AssignedDriverCard } from './identity';
import type { FareBreakdown } from './pricing';
import type { CurrencyCode, ISODateTime, MinorUnits, Place, RouteEstimate, Timestamps, UUID } from './common';

/**
 * Trip lifecycle.
 *
 * The happy path is linear; exception states hang off it. Transitions are
 * enforced centrally by the trip state machine — no module mutates
 * `trips.status` directly.
 */
export const TRIP_STATUSES = [
  'REQUESTED',
  'FARE_CALCULATED',
  'NEGOTIATING',
  'FARE_ACCEPTED',
  'FARE_LOCKED',
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
  'TRIP_STARTED',
  'TRIP_COMPLETED',
  'PAYMENT_PENDING',
  'PAYMENT_COMPLETED',
  'REVIEW_PENDING',
  'COMPLETED',
  // Exception states
  'CANCELLED',
  'EXPIRED',
  'DRIVER_UNAVAILABLE',
  'REASSIGNED',
  'PAYMENT_FAILED',
  'DISPUTED',
  'NO_SHOW',
] as const;

export type TripStatus = (typeof TRIP_STATUSES)[number];

/** Who or what caused a transition. Recorded on every history row. */
export type TransitionActorType = 'customer' | 'driver' | 'admin' | 'system';

export type TripType = 'immediate' | 'scheduled';

export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'wallet';

export interface Trip extends Timestamps {
  id: UUID;
  /** Human reference shown everywhere in ops, e.g. TRP-1032. */
  reference: string;
  customerId: UUID;
  driverId: UUID | null;
  vehicleId: UUID | null;
  status: TripStatus;
  type: TripType;

  pickup: Place;
  destination: Place;
  passengers: number;
  specialInstructions: string | null;

  route: RouteEstimate;
  currency: CurrencyCode;

  /** The company's original calculated fare. Never mutated. */
  quotedFareMinor: MinorUnits;
  /** The agreed fare after negotiation. Null until FARE_ACCEPTED. */
  finalFareMinor: MinorUnits | null;
  /** Immutable snapshot of the breakdown that produced quotedFareMinor. */
  fareBreakdown: FareBreakdown;
  fareQuoteId: UUID | null;
  pricingRuleSetId: UUID;
  pricingVersion: number;
  fareLockedAt: ISODateTime | null;

  scheduledPickupAt: ISODateTime | null;
  assignedAt: ISODateTime | null;
  driverEnRouteAt: ISODateTime | null;
  driverArrivedAt: ISODateTime | null;
  startedAt: ISODateTime | null;
  completedAt: ISODateTime | null;
  cancelledAt: ISODateTime | null;

  cancellationReason: string | null;
  cancelledByType: TransitionActorType | null;
  cancellationFeeMinor: MinorUnits | null;

  paymentMethod: PaymentMethod | null;
  paymentStatus: 'unpaid' | 'pending' | 'paid' | 'failed' | 'refunded' | 'partially_refunded';

  /** Distance/duration actually driven, filled in at completion from GPS. */
  actualDistanceMetres: number | null;
  actualDurationSeconds: number | null;

  /** Optimistic-concurrency guard. Every state write bumps this. */
  version: number;
}

export interface TripStatusHistoryEntry {
  id: UUID;
  tripId: UUID;
  fromStatus: TripStatus | null;
  toStatus: TripStatus;
  actorType: TransitionActorType;
  actorUserId: UUID | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: ISODateTime;
}

/** GPS breadcrumb recorded during a trip, used for replay and fraud checks. */
export interface TripLocationPoint {
  id: UUID;
  tripId: UUID;
  driverId: UUID;
  latitude: number;
  longitude: number;
  headingDegrees: number | null;
  speedMetresPerSecond: number | null;
  accuracyMetres: number | null;
  recordedAt: ISODateTime;
  createdAt: ISODateTime;
}

/** The customer-facing projection of a trip. Excludes internal fields. */
export interface CustomerTripView {
  id: UUID;
  reference: string;
  status: TripStatus;
  type: TripType;
  pickup: Place;
  destination: Place;
  passengers: number;
  currency: CurrencyCode;
  quotedFareMinor: MinorUnits;
  finalFareMinor: MinorUnits | null;
  fareLocked: boolean;
  scheduledPickupAt: ISODateTime | null;
  driver: AssignedDriverCard | null;
  etaSeconds: number | null;
  paymentMethod: PaymentMethod | null;
  paymentStatus: Trip['paymentStatus'];
  createdAt: ISODateTime;
  /** Plain-language status line, e.g. "Your driver is on the way". */
  statusLabel: string;
}

/** The driver-facing projection. Contains no negotiation data and no fare controls. */
export interface DriverTripView {
  id: UUID;
  reference: string;
  status: TripStatus;
  type: TripType;
  customerName: string;
  customerMaskedPhone: string;
  pickup: Place;
  destination: Place;
  passengers: number;
  specialInstructions: string | null;
  /** Read-only. Drivers can never edit or negotiate a fare. */
  agreedFareMinor: MinorUnits;
  currency: CurrencyCode;
  paymentMethod: PaymentMethod | null;
  scheduledPickupAt: ISODateTime | null;
  distanceMetres: number;
  durationSeconds: number;
}

export interface ScheduledRide extends Timestamps {
  id: UUID;
  tripId: UUID;
  customerId: UUID;
  scheduledPickupAt: ISODateTime;
  /** Driver committed at booking time so the customer knows who is coming. */
  assignedDriverId: UUID | null;
  status: 'scheduled' | 'driver_unavailable' | 'reassigned' | 'dispatched' | 'cancelled' | 'completed';
  reminderSentAt: ISODateTime | null;
  dispatchDueAt: ISODateTime;
  reassignmentCount: number;
}
