import type {
  MinorUnits,
  NegotiationDecision,
  NegotiationPolicy,
  NegotiationStatus,
} from '@transportco/types';
import { discountPercent, formatMoney, roundUpToIncrement } from '@transportco/utils';

/**
 * THE NEGOTIATION ENGINE.
 *
 * The defining feature of TransportCo: the customer negotiates with THE
 * COMPANY, never with the driver. Drivers do not see this module's output and
 * have no endpoint that reaches it.
 *
 * Pure and deterministic. It takes the negotiation's current state plus the
 * policy from the pricing rule set, and returns a decision. Persistence,
 * notifications and realtime fan-out are the caller's business.
 *
 * Two invariants this file exists to protect:
 *
 *  1. THE FLOOR NEVER LEAKS. Every customer-facing message is written so that
 *     replaying the negotiation cannot reveal the lowest acceptable price. If
 *     the customer could see the floor, the negotiation would collapse into a
 *     single move to it and the feature would cost the company money on every
 *     trip.
 *
 *  2. THE ROUND LIMIT BINDS THE CUSTOMER, NOT THE COMPANY. A customer gets a
 *     configured number of offers (2 by default). Company counteroffers are
 *     unlimited — the brief is explicit that internal counters must not be
 *     constrained by the customer's cap.
 */

export interface NegotiationState {
  status: NegotiationStatus;
  originalFareMinor: MinorUnits;
  /** Internal. The lowest fare the company will accept. */
  floorMinor: MinorUnits;
  /** Internal. At or above this, the system accepts without a human. */
  autoAcceptAtOrAboveMinor: MinorUnits;
  /** The company's live position — its latest counter, else the original fare. */
  companyPositionMinor: MinorUnits;
  customerRoundsUsed: number;
  maxCustomerRounds: number;
}

const OPEN_STATUSES: NegotiationStatus[] = ['OPEN', 'AWAITING_CUSTOMER', 'AWAITING_COMPANY'];

export function isNegotiable(status: NegotiationStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/**
 * Evaluate a customer's offer.
 *
 * Bands, from the top down:
 *   offer >= company position   -> accept (they met or beat us)
 *   offer >= auto-accept        -> accept, no human involved
 *   offer >= floor              -> a human decides, or the system counters
 *   offer <  floor              -> reject; below this the trip is not worth running
 */
export function evaluateCustomerOffer(
  state: NegotiationState,
  offerMinor: MinorUnits,
  policy: NegotiationPolicy,
): NegotiationDecision {
  if (!policy.enabled) {
    return {
      kind: 'INVALID',
      reasonCode: 'negotiation_disabled',
      customerMessage: 'This fare is not open to negotiation.',
      internalNote: 'Negotiation is disabled in the active pricing rule set.',
    };
  }

  if (!isNegotiable(state.status)) {
    return {
      kind: 'INVALID',
      reasonCode: 'negotiation_closed',
      customerMessage: 'This fare is no longer open for offers.',
      internalNote: `Negotiation is in a terminal state (${state.status}).`,
    };
  }

  if (!Number.isInteger(offerMinor) || offerMinor <= 0) {
    return {
      kind: 'INVALID',
      reasonCode: 'offer_not_positive',
      customerMessage: 'Enter an amount greater than zero.',
      internalNote: `Rejected malformed offer: ${offerMinor}.`,
    };
  }

  // Offering more than the quoted fare is almost always a typo (a customer
  // typing 70,000 instead of 7,000). Refusing it protects them from themselves
  // and protects us from a complaint later.
  if (offerMinor > state.originalFareMinor) {
    return {
      kind: 'INVALID',
      reasonCode: 'offer_above_quote',
      customerMessage: `Your offer is above the fare of ${formatMoney(state.originalFareMinor)}. You can simply accept the fare.`,
      internalNote: 'Customer offered above the quoted fare; treated as an input error.',
    };
  }

  // Meeting the company's live position is an acceptance however it is typed.
  if (offerMinor >= state.companyPositionMinor) {
    return {
      kind: 'ACCEPT',
      reasonCode: 'at_or_above_company_position',
      customerMessage: 'Your fare is agreed.',
      internalNote: `Offer ${offerMinor} met the company position ${state.companyPositionMinor}.`,
    };
  }

  // The round limit is checked AFTER the acceptance paths above, so a customer
  // who has used their offers can still close the deal by meeting our number.
  if (state.customerRoundsUsed >= state.maxCustomerRounds) {
    return {
      kind: 'LIMIT_REACHED',
      reasonCode: 'round_limit_reached',
      customerMessage: `You have used your ${state.maxCustomerRounds} offers for this trip. You can accept ${formatMoney(state.companyPositionMinor)} or cancel the request.`,
      internalNote: `Customer exhausted ${state.maxCustomerRounds} offers.`,
    };
  }

  if (offerMinor >= state.autoAcceptAtOrAboveMinor) {
    return {
      kind: 'ACCEPT',
      reasonCode: 'at_or_above_auto_accept',
      customerMessage: 'Your offer is accepted.',
      internalNote: `Auto-accepted: offer ${offerMinor} >= threshold ${state.autoAcceptAtOrAboveMinor}.`,
    };
  }

  if (offerMinor < state.floorMinor) {
    return {
      kind: 'REJECT',
      reasonCode: 'below_floor',
      // Deliberately vague: naming the floor here would hand it over.
      customerMessage: `We cannot run this trip at ${formatMoney(offerMinor)}. Our best price is ${formatMoney(state.companyPositionMinor)}.`,
      internalNote: `Auto-rejected: offer ${offerMinor} < floor ${state.floorMinor} (${discountPercent(state.originalFareMinor, offerMinor)}% off).`,
    };
  }

  // In the review band. A human decides when dispatch is staffed; otherwise the
  // system meets the customer part-way so nobody waits on an empty desk.
  if (policy.adminReviewEnabled) {
    return {
      kind: 'REVIEW',
      reasonCode: 'within_review_band',
      customerMessage: 'We are reviewing your offer. You will hear back shortly.',
      internalNote: `Offer ${offerMinor} sits between floor ${state.floorMinor} and auto-accept ${state.autoAcceptAtOrAboveMinor}; sent for review.`,
    };
  }

  const counter = computeAutoCounter(state, offerMinor, policy);
  if (counter === null) {
    return {
      kind: 'ACCEPT',
      reasonCode: 'at_or_above_auto_accept',
      customerMessage: 'Your offer is accepted.',
      internalNote: 'Auto-counter would not have improved on the offer; accepted instead.',
    };
  }

  return {
    kind: 'COUNTER',
    counterAmountMinor: counter,
    reasonCode: 'auto_counter',
    customerMessage: `We can do ${formatMoney(counter)} for this trip.`,
    internalNote: `Auto-countered ${counter} against offer ${offerMinor} (floor ${state.floorMinor}).`,
  };
}

/**
 * Where the company moves to when it counters automatically.
 *
 * It travels `autoCounterMeetRatio` of the distance from its own position
 * toward the customer's offer, then is clamped to the floor and rounded to a
 * clean increment. Returns null when the resulting counter would be no better
 * for us than simply accepting — in that case, accept.
 */
export function computeAutoCounter(
  state: NegotiationState,
  offerMinor: MinorUnits,
  policy: NegotiationPolicy,
  roundToNearestMinor = 5_000,
): MinorUnits | null {
  if (policy.autoCounterMeetRatio <= 0) return null;

  const gap = state.companyPositionMinor - offerMinor;
  if (gap <= 0) return null;

  const raw = state.companyPositionMinor - Math.round(gap * policy.autoCounterMeetRatio);
  // Round UP so rounding never quietly walks us below where we meant to stop.
  const rounded = roundUpToIncrement(Math.max(raw, state.floorMinor), roundToNearestMinor);
  const counter = Math.min(rounded, state.companyPositionMinor);

  // A counter must sit strictly between the two positions to mean anything.
  if (counter <= offerMinor) return null;
  if (counter >= state.companyPositionMinor) return null;

  return counter;
}

export type AdminCounterProblem =
  | 'negotiation_closed'
  | 'not_positive'
  | 'above_company_position'
  | 'below_floor_without_override'
  | 'below_minimum_possible';

export interface AdminCounterValidation {
  valid: boolean;
  problem?: AdminCounterProblem;
  message?: string;
  /** True when the counter is below the floor and an override was supplied. */
  requiresAudit: boolean;
}

/**
 * Validate an admin counteroffer.
 *
 * An administrator may go below the floor — sometimes a corporate relationship
 * or a service failure justifies it — but only with an explicit override, which
 * demands the `negotiation:override_floor` permission and writes an audit entry.
 * Never a silent exception.
 */
export function validateAdminCounter(
  state: NegotiationState,
  counterMinor: MinorUnits,
  options: { overrideFloor: boolean; absoluteMinimumMinor?: MinorUnits },
): AdminCounterValidation {
  if (!isNegotiable(state.status)) {
    return {
      valid: false,
      problem: 'negotiation_closed',
      message: 'This negotiation is closed.',
      requiresAudit: false,
    };
  }

  if (!Number.isInteger(counterMinor) || counterMinor <= 0) {
    return {
      valid: false,
      problem: 'not_positive',
      message: 'Enter a counteroffer greater than zero.',
      requiresAudit: false,
    };
  }

  // A counter that raises the price is not a negotiation, it is a bait and
  // switch. The company's position may only move down.
  if (counterMinor > state.companyPositionMinor) {
    return {
      valid: false,
      problem: 'above_company_position',
      message: `A counteroffer cannot be above the current company position of ${formatMoney(state.companyPositionMinor)}.`,
      requiresAudit: false,
    };
  }

  if (counterMinor < state.floorMinor) {
    if (!options.overrideFloor) {
      return {
        valid: false,
        problem: 'below_floor_without_override',
        message: `This is below the minimum acceptable fare of ${formatMoney(state.floorMinor)}. Use an explicit override if you intend to approve it.`,
        requiresAudit: false,
      };
    }

    const absoluteMinimum = options.absoluteMinimumMinor ?? 0;
    if (counterMinor < absoluteMinimum) {
      return {
        valid: false,
        problem: 'below_minimum_possible',
        message: `Even with an override, a fare below ${formatMoney(absoluteMinimum)} cannot be approved.`,
        requiresAudit: false,
      };
    }

    return { valid: true, requiresAudit: true };
  }

  return { valid: true, requiresAudit: false };
}

/** Server-authoritative expiry check. Client countdowns are decoration. */
export function isOfferExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** Seconds remaining on an offer, floored at zero — what the countdown renders. */
export function secondsRemaining(expiresAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
}

/**
 * The state a negotiation moves to after a decision. Kept beside the decision
 * logic so the two can never drift apart.
 */
export function nextStatusAfterDecision(kind: NegotiationDecision['kind']): NegotiationStatus {
  switch (kind) {
    case 'ACCEPT':
      return 'ACCEPTED';
    case 'REJECT':
      return 'AWAITING_CUSTOMER'; // rejected THIS offer; the customer may still accept our price
    case 'COUNTER':
      return 'AWAITING_CUSTOMER';
    case 'REVIEW':
      return 'AWAITING_COMPANY';
    case 'LIMIT_REACHED':
      return 'AWAITING_CUSTOMER';
    case 'INVALID':
    default:
      return 'OPEN';
  }
}
