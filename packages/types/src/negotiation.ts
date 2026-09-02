import type { CurrencyCode, ISODateTime, MinorUnits, Timestamps, UUID } from './common';

/**
 * Negotiation is between the CUSTOMER and THE COMPANY. Drivers are never party
 * to it and never see it.
 *
 * A `Negotiation` is the conversation for one trip; `NegotiationOffer` rows are
 * its immutable messages. The company's position at any moment is the latest
 * company offer (or the original quote if it has not countered yet).
 */

export type NegotiationStatus =
  | 'OPEN'
  | 'AWAITING_CUSTOMER'
  | 'AWAITING_COMPANY'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export type OfferParty = 'customer' | 'company';

export type OfferStatus = 'pending' | 'accepted' | 'rejected' | 'countered' | 'expired' | 'withdrawn';

/** How an offer was resolved. Drives analytics on automation vs human effort. */
export type OfferResolution =
  | 'auto_accepted'
  | 'auto_rejected'
  | 'auto_countered'
  | 'admin_accepted'
  | 'admin_rejected'
  | 'admin_countered'
  | 'customer_accepted'
  | 'customer_rejected'
  | 'expired';

export interface NegotiationOffer {
  id: UUID;
  negotiationId: UUID;
  tripId: UUID;
  sequence: number;
  party: OfferParty;
  /** Null for the system; set for a customer user or the admin who countered. */
  actorUserId: UUID | null;
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  message: string | null;
  status: OfferStatus;
  resolution: OfferResolution | null;
  /** Server-authoritative expiry. The client only renders the countdown. */
  expiresAt: ISODateTime;
  respondedAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface Negotiation extends Timestamps {
  id: UUID;
  tripId: UUID;
  customerId: UUID;
  status: NegotiationStatus;
  currency: CurrencyCode;

  /** The company's opening fare. Immutable. */
  originalFareMinor: MinorUnits;
  /** Hard floor from the pricing rule set. Never exposed to the customer. */
  floorMinor: MinorUnits;
  /** Auto-accept threshold from the pricing rule set. Never exposed to the customer. */
  autoAcceptAtOrAboveMinor: MinorUnits;
  /** The company's current position — its latest counter, else the original fare. */
  companyPositionMinor: MinorUnits;
  /** The customer's latest offer, if any. */
  customerPositionMinor: MinorUnits | null;

  /** Customer offers used so far, against the policy cap. */
  customerRoundsUsed: number;
  maxCustomerRounds: number;

  finalFareMinor: MinorUnits | null;
  acceptedAt: ISODateTime | null;
  acceptedByParty: OfferParty | null;
  /** Points at the offer that is currently awaiting a response. */
  pendingOfferId: UUID | null;
  pricingRuleSetId: UUID;
  pricingVersion: number;
}

/** Decision returned by the negotiation engine for a customer offer. */
export type NegotiationDecisionKind =
  | 'ACCEPT'
  | 'REJECT'
  | 'COUNTER'
  | 'REVIEW'
  | 'LIMIT_REACHED'
  | 'INVALID';

export interface NegotiationDecision {
  kind: NegotiationDecisionKind;
  /** Present for COUNTER. */
  counterAmountMinor?: MinorUnits;
  /** Machine-readable justification, surfaced in the admin console and audit log. */
  reasonCode:
    | 'at_or_above_auto_accept'
    | 'at_or_above_company_position'
    | 'below_floor'
    | 'within_review_band'
    | 'auto_counter'
    | 'round_limit_reached'
    | 'negotiation_closed'
    | 'offer_not_positive'
    | 'offer_above_quote'
    | 'negotiation_disabled';
  /** Customer-safe explanation. Must never leak the floor or the accept threshold. */
  customerMessage: string;
  /** Internal explanation for the admin console. May reference the floor. */
  internalNote: string;
}

/** Row shape for the admin negotiation console queue. */
export interface NegotiationQueueItem {
  negotiationId: UUID;
  tripId: UUID;
  tripReference: string;
  customerId: UUID;
  customerName: string;
  customerRating: number | null;
  originalFareMinor: MinorUnits;
  customerOfferMinor: MinorUnits;
  floorMinor: MinorUnits;
  companyPositionMinor: MinorUnits;
  discountPercent: number;
  roundsUsed: number;
  maxRounds: number;
  pickupAddress: string;
  destinationAddress: string;
  distanceMetres: number;
  expiresAt: ISODateTime;
  createdAt: ISODateTime;
}
