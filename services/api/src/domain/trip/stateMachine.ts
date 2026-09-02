import type { TransitionActorType, TripStatus } from '@transportco/types';

/**
 * THE TRIP STATE MACHINE.
 *
 * Nothing in the codebase writes `trips.status` directly. Every change goes
 * through `assertTransition`, which answers three questions:
 *
 *   1. Is this transition legal at all?
 *   2. Is this actor allowed to make it? (A driver cannot mark a fare locked; a
 *      customer cannot start a trip.)
 *   3. Are the trip's own preconditions satisfied? (No driver assignment
 *      without a locked fare; no completion without a driver.)
 *
 * Encoding the graph as data rather than as scattered `if` statements is what
 * makes it reviewable — and reviewing it is how you find out that the
 * "impossible" state your support team keeps seeing was in fact reachable.
 */

type ActorSet = readonly TransitionActorType[];

interface TransitionRule {
  to: TripStatus;
  actors: ActorSet;
  /** Human description used in error messages and in the generated docs. */
  description: string;
}

const SYSTEM_ONLY: ActorSet = ['system'];
const ADMIN_OR_SYSTEM: ActorSet = ['admin', 'system'];
const DRIVER_ONLY: ActorSet = ['driver'];
const DRIVER_OR_ADMIN: ActorSet = ['driver', 'admin'];
const CUSTOMER_OR_ADMIN: ActorSet = ['customer', 'admin'];
const ANY_ACTOR: ActorSet = ['customer', 'driver', 'admin', 'system'];

/**
 * The transition graph.
 *
 * Terminal states (COMPLETED, CANCELLED, EXPIRED) have no outbound edges except
 * DISPUTED, which support may raise against a completed trip.
 */
export const TRIP_TRANSITIONS: Readonly<Record<TripStatus, readonly TransitionRule[]>> = {
  REQUESTED: [
    { to: 'FARE_CALCULATED', actors: SYSTEM_ONLY, description: 'Pricing engine produced a fare' },
    { to: 'CANCELLED', actors: CUSTOMER_OR_ADMIN, description: 'Cancelled before pricing' },
    { to: 'EXPIRED', actors: SYSTEM_ONLY, description: 'Request abandoned' },
  ],

  FARE_CALCULATED: [
    { to: 'NEGOTIATING', actors: ['customer'], description: 'Customer submitted an offer' },
    { to: 'FARE_ACCEPTED', actors: ['customer'], description: 'Customer accepted the quoted fare' },
    { to: 'CANCELLED', actors: CUSTOMER_OR_ADMIN, description: 'Cancelled before agreeing a fare' },
    { to: 'EXPIRED', actors: SYSTEM_ONLY, description: 'Quote expired' },
  ],

  NEGOTIATING: [
    { to: 'FARE_ACCEPTED', actors: ANY_ACTOR, description: 'An offer was accepted by either party' },
    { to: 'FARE_CALCULATED', actors: ADMIN_OR_SYSTEM, description: 'Offer rejected; the quoted fare still stands' },
    { to: 'CANCELLED', actors: CUSTOMER_OR_ADMIN, description: 'Cancelled during negotiation' },
    { to: 'EXPIRED', actors: SYSTEM_ONLY, description: 'Negotiation timed out' },
  ],

  FARE_ACCEPTED: [
    { to: 'FARE_LOCKED', actors: SYSTEM_ONLY, description: 'Fare locked and made immutable' },
    { to: 'CANCELLED', actors: CUSTOMER_OR_ADMIN, description: 'Cancelled after agreeing a fare' },
  ],

  FARE_LOCKED: [
    { to: 'DRIVER_ASSIGNED', actors: ADMIN_OR_SYSTEM, description: 'Dispatch assigned a driver' },
    { to: 'CANCELLED', actors: CUSTOMER_OR_ADMIN, description: 'Cancelled before assignment' },
    { to: 'EXPIRED', actors: SYSTEM_ONLY, description: 'No driver could be assigned in time' },
  ],

  DRIVER_ASSIGNED: [
    { to: 'DRIVER_EN_ROUTE', actors: DRIVER_ONLY, description: 'Driver started travelling to pickup' },
    { to: 'REASSIGNED', actors: ADMIN_OR_SYSTEM, description: 'Assignment moved to another driver' },
    { to: 'DRIVER_UNAVAILABLE', actors: ADMIN_OR_SYSTEM, description: 'Assigned driver became unavailable' },
    { to: 'CANCELLED', actors: CUSTOMER_OR_ADMIN, description: 'Cancelled after assignment' },
  ],

  DRIVER_EN_ROUTE: [
    { to: 'DRIVER_ARRIVED', actors: DRIVER_ONLY, description: 'Driver reached the pickup point' },
    { to: 'REASSIGNED', actors: ADMIN_OR_SYSTEM, description: 'Reassigned while en route' },
    { to: 'DRIVER_UNAVAILABLE', actors: ADMIN_OR_SYSTEM, description: 'Driver dropped out en route' },
    { to: 'CANCELLED', actors: CUSTOMER_OR_ADMIN, description: 'Cancelled while the driver was on the way' },
  ],

  DRIVER_ARRIVED: [
    { to: 'TRIP_STARTED', actors: DRIVER_ONLY, description: 'Customer boarded and the trip began' },
    { to: 'NO_SHOW', actors: DRIVER_OR_ADMIN, description: 'Customer did not appear' },
    { to: 'CANCELLED', actors: CUSTOMER_OR_ADMIN, description: 'Cancelled at the pickup point' },
    { to: 'REASSIGNED', actors: ADMIN_OR_SYSTEM, description: 'Reassigned at pickup' },
  ],

  TRIP_STARTED: [
    { to: 'TRIP_COMPLETED', actors: DRIVER_OR_ADMIN, description: 'Driver completed the trip' },
    { to: 'DISPUTED', actors: ADMIN_OR_SYSTEM, description: 'Incident raised mid-trip' },
  ],

  TRIP_COMPLETED: [
    { to: 'PAYMENT_PENDING', actors: SYSTEM_ONLY, description: 'Awaiting payment' },
    { to: 'PAYMENT_COMPLETED', actors: SYSTEM_ONLY, description: 'Payment already settled' },
    { to: 'DISPUTED', actors: ADMIN_OR_SYSTEM, description: 'Disputed after completion' },
  ],

  PAYMENT_PENDING: [
    { to: 'PAYMENT_COMPLETED', actors: SYSTEM_ONLY, description: 'Payment verified' },
    { to: 'PAYMENT_FAILED', actors: SYSTEM_ONLY, description: 'Payment failed or was abandoned' },
    { to: 'DISPUTED', actors: ADMIN_OR_SYSTEM, description: 'Disputed while awaiting payment' },
  ],

  PAYMENT_FAILED: [
    { to: 'PAYMENT_PENDING', actors: ANY_ACTOR, description: 'Customer retried payment' },
    { to: 'PAYMENT_COMPLETED', actors: SYSTEM_ONLY, description: 'A later attempt succeeded' },
    { to: 'DISPUTED', actors: ADMIN_OR_SYSTEM, description: 'Escalated to a dispute' },
  ],

  PAYMENT_COMPLETED: [
    { to: 'REVIEW_PENDING', actors: SYSTEM_ONLY, description: 'Awaiting the customer rating' },
    { to: 'COMPLETED', actors: SYSTEM_ONLY, description: 'Closed without a rating' },
    { to: 'DISPUTED', actors: ADMIN_OR_SYSTEM, description: 'Disputed after payment' },
  ],

  REVIEW_PENDING: [
    { to: 'COMPLETED', actors: ['customer', 'system'], description: 'Rating submitted or review window closed' },
    { to: 'DISPUTED', actors: ADMIN_OR_SYSTEM, description: 'Disputed before closing' },
  ],

  // Exception states
  DRIVER_UNAVAILABLE: [
    { to: 'DRIVER_ASSIGNED', actors: ADMIN_OR_SYSTEM, description: 'Replacement driver assigned' },
    { to: 'CANCELLED', actors: ADMIN_OR_SYSTEM, description: 'No replacement available' },
  ],

  REASSIGNED: [
    { to: 'DRIVER_ASSIGNED', actors: ADMIN_OR_SYSTEM, description: 'New driver took the trip' },
    { to: 'CANCELLED', actors: ADMIN_OR_SYSTEM, description: 'Reassignment abandoned' },
  ],

  NO_SHOW: [
    { to: 'PAYMENT_PENDING', actors: SYSTEM_ONLY, description: 'No-show fee raised' },
    { to: 'COMPLETED', actors: ADMIN_OR_SYSTEM, description: 'Closed with no fee' },
    { to: 'DISPUTED', actors: ADMIN_OR_SYSTEM, description: 'Customer disputed the no-show' },
  ],

  DISPUTED: [
    { to: 'COMPLETED', actors: ADMIN_OR_SYSTEM, description: 'Dispute resolved' },
    { to: 'CANCELLED', actors: ADMIN_OR_SYSTEM, description: 'Trip voided after a dispute' },
    { to: 'PAYMENT_PENDING', actors: ADMIN_OR_SYSTEM, description: 'Corrected amount now due' },
  ],

  COMPLETED: [
    { to: 'DISPUTED', actors: ADMIN_OR_SYSTEM, description: 'Reopened as a dispute' },
  ],

  CANCELLED: [],
  EXPIRED: [],
};

/** Trip is finished: no further work, no dispatch, no payment expected. */
export const TERMINAL_STATUSES: readonly TripStatus[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

/** Trip currently occupies a driver. */
export const ACTIVE_STATUSES: readonly TripStatus[] = [
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
  'TRIP_STARTED',
];

/** Trip is waiting for dispatch attention. */
export const DISPATCHABLE_STATUSES: readonly TripStatus[] = ['FARE_LOCKED', 'DRIVER_UNAVAILABLE', 'REASSIGNED'];

export interface TransitionContext {
  hasDriver: boolean;
  hasFinalFare: boolean;
  fareLocked: boolean;
  paymentSettled: boolean;
  /** Set when an administrator invoked `trip:force_state`. */
  forced?: boolean;
}

export type TransitionFailure =
  | { code: 'illegal_transition'; message: string }
  | { code: 'actor_not_permitted'; message: string }
  | { code: 'precondition_failed'; message: string };

export function canTransition(from: TripStatus, to: TripStatus): boolean {
  return TRIP_TRANSITIONS[from].some((rule) => rule.to === to);
}

export function allowedTransitions(from: TripStatus, actor?: TransitionActorType): TripStatus[] {
  return TRIP_TRANSITIONS[from]
    .filter((rule) => !actor || rule.actors.includes(actor))
    .map((rule) => rule.to);
}

/**
 * Preconditions that the graph alone cannot express. These are the invariants
 * that keep money and dispatch honest.
 */
function checkPreconditions(to: TripStatus, context: TransitionContext): TransitionFailure | null {
  switch (to) {
    case 'FARE_LOCKED':
      if (!context.hasFinalFare) {
        return { code: 'precondition_failed', message: 'A fare cannot be locked before one is agreed.' };
      }
      return null;

    case 'DRIVER_ASSIGNED':
      if (!context.fareLocked) {
        return { code: 'precondition_failed', message: 'A driver cannot be assigned before the fare is locked.' };
      }
      if (!context.hasDriver) {
        return { code: 'precondition_failed', message: 'No driver was supplied for the assignment.' };
      }
      return null;

    case 'DRIVER_EN_ROUTE':
    case 'DRIVER_ARRIVED':
    case 'TRIP_STARTED':
    case 'TRIP_COMPLETED':
      if (!context.hasDriver) {
        return { code: 'precondition_failed', message: 'This trip has no assigned driver.' };
      }
      return null;

    case 'PAYMENT_COMPLETED':
      if (!context.paymentSettled) {
        return {
          code: 'precondition_failed',
          message: 'Payment is not verified. A trip is never marked paid on a client claim.',
        };
      }
      return null;

    default:
      return null;
  }
}

export interface TransitionCheck {
  allowed: boolean;
  failure?: TransitionFailure;
}

export function checkTransition(
  from: TripStatus,
  to: TripStatus,
  actor: TransitionActorType,
  context: TransitionContext,
): TransitionCheck {
  const rule = TRIP_TRANSITIONS[from].find((candidate) => candidate.to === to);

  if (!rule) {
    return {
      allowed: false,
      failure: {
        code: 'illegal_transition',
        message: `A trip cannot move from ${from} to ${to}.`,
      },
    };
  }

  // A forced transition still has to be a legal EDGE — an administrator may
  // skip a step, never invent one. Actor and precondition checks are what the
  // override waives, and it is audited by the caller.
  if (context.forced && actor === 'admin') {
    return { allowed: true };
  }

  if (!rule.actors.includes(actor)) {
    return {
      allowed: false,
      failure: {
        code: 'actor_not_permitted',
        message: `A ${actor} cannot move a trip from ${from} to ${to}.`,
      },
    };
  }

  const preconditionFailure = checkPreconditions(to, context);
  if (preconditionFailure) {
    return { allowed: false, failure: preconditionFailure };
  }

  return { allowed: true };
}

/** Throwing variant for call sites where an illegal transition is a bug. */
export function assertTransition(
  from: TripStatus,
  to: TripStatus,
  actor: TransitionActorType,
  context: TransitionContext,
): void {
  const result = checkTransition(from, to, actor, context);
  if (!result.allowed) {
    const error = new Error(result.failure?.message ?? 'Illegal trip state transition');
    error.name = 'InvalidTripTransition';
    throw error;
  }
}

/** Plain-language status line for the customer app. */
export function customerStatusLabel(status: TripStatus): string {
  const labels: Record<TripStatus, string> = {
    REQUESTED: 'Getting your fare ready',
    FARE_CALCULATED: 'Your fare is ready',
    NEGOTIATING: 'We are reviewing your offer',
    FARE_ACCEPTED: 'Fare agreed',
    FARE_LOCKED: 'Finding your driver',
    DRIVER_ASSIGNED: 'Driver assigned',
    DRIVER_EN_ROUTE: 'Your driver is on the way',
    DRIVER_ARRIVED: 'Your driver has arrived',
    TRIP_STARTED: 'Trip in progress',
    TRIP_COMPLETED: 'Trip completed',
    PAYMENT_PENDING: 'Payment pending',
    PAYMENT_COMPLETED: 'Payment received',
    REVIEW_PENDING: 'Rate your trip',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
    EXPIRED: 'Expired',
    DRIVER_UNAVAILABLE: 'Arranging another driver',
    REASSIGNED: 'Driver changed',
    PAYMENT_FAILED: 'Payment failed',
    DISPUTED: 'Under review',
    NO_SHOW: 'Marked as no-show',
  };
  return labels[status];
}
