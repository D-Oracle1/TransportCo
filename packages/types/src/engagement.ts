import type { CurrencyCode, GeoPoint, ISODateTime, MinorUnits, Timestamps, UUID } from './common';

// --- Loyalty ---------------------------------------------------------------

/**
 * Loyalty is a ledger, not a counter. `loyalty_accounts.balance` is a cached
 * projection; the truth is the sum of `loyalty_transactions`. Any adjustment
 * writes a transaction row, always.
 */
export interface LoyaltyAccount extends Timestamps {
  id: UUID;
  customerId: UUID;
  balancePoints: number;
  lifetimeEarnedPoints: number;
  lifetimeRedeemedPoints: number;
  tier: 'standard' | 'silver' | 'gold' | 'platinum';
}

export type LoyaltyTransactionType = 'earn' | 'redeem' | 'expire' | 'adjustment' | 'reversal';

export interface LoyaltyTransaction {
  id: UUID;
  accountId: UUID;
  customerId: UUID;
  type: LoyaltyTransactionType;
  /** Signed. Earn is positive, redeem/expire negative. */
  points: number;
  balanceAfter: number;
  tripId: UUID | null;
  /** Spend that generated the points, for audit. */
  sourceAmountMinor: MinorUnits | null;
  ruleId: UUID | null;
  reason: string;
  actorUserId: UUID | null;
  expiresAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface RewardRule extends Timestamps {
  id: UUID;
  code: string;
  name: string;
  active: boolean;
  spendUnitMinor: MinorUnits;
  pointsPerUnit: number;
  pointValueMinor: MinorUnits;
  minimumRedeemablePoints: number;
  maxRedemptionPercentOfFare: number;
  validFrom: ISODateTime;
  validTo: ISODateTime | null;
}

export interface Redemption extends Timestamps {
  id: UUID;
  customerId: UUID;
  tripId: UUID;
  points: number;
  valueMinor: MinorUnits;
  currency: CurrencyCode;
  status: 'applied' | 'reversed';
  loyaltyTransactionId: UUID;
}

// --- Reviews ---------------------------------------------------------------

export interface Review extends Timestamps {
  id: UUID;
  tripId: UUID;
  customerId: UUID;
  driverId: UUID;
  /** 1..5 */
  driverRating: number;
  serviceRating: number | null;
  comment: string | null;
  /** Only ratings from completed, paid trips count towards a driver average. */
  verified: boolean;
  tags: string[];
}

// --- Support ---------------------------------------------------------------

export type SupportCategory =
  | 'driver_did_not_arrive'
  | 'driver_issue'
  | 'payment_problem'
  | 'incorrect_charge'
  | 'lost_item'
  | 'trip_issue'
  | 'cancellation'
  | 'safety_issue'
  | 'other';

export type SupportTicketStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'WAITING_FOR_CUSTOMER'
  | 'RESOLVED'
  | 'CLOSED';

export type SupportPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface SupportTicket extends Timestamps {
  id: UUID;
  reference: string;
  /** Tickets can come from a customer or a driver. */
  raisedByUserId: UUID;
  customerId: UUID | null;
  driverId: UUID | null;
  tripId: UUID | null;
  category: SupportCategory;
  subject: string;
  status: SupportTicketStatus;
  priority: SupportPriority;
  assignedToUserId: UUID | null;
  resolvedAt: ISODateTime | null;
  closedAt: ISODateTime | null;
  resolutionNote: string | null;
}

export interface SupportMessage {
  id: UUID;
  ticketId: UUID;
  authorUserId: UUID;
  authorRole: 'customer' | 'driver' | 'agent' | 'system';
  body: string;
  /** Agent-only notes never rendered to the customer. */
  internal: boolean;
  attachments: string[];
  createdAt: ISODateTime;
}

// --- Emergency -------------------------------------------------------------

export type EmergencyType = 'sos' | 'accident' | 'harassment' | 'vehicle_breakdown' | 'medical' | 'other';

export type EmergencyStatus = 'open' | 'acknowledged' | 'responding' | 'resolved' | 'false_alarm';

export interface EmergencyIncident extends Timestamps {
  id: UUID;
  reference: string;
  raisedByUserId: UUID;
  raisedByType: 'customer' | 'driver';
  tripId: UUID | null;
  driverId: UUID | null;
  customerId: UUID | null;
  type: EmergencyType;
  status: EmergencyStatus;
  location: GeoPoint | null;
  locationAddress: string | null;
  note: string | null;
  acknowledgedByUserId: UUID | null;
  acknowledgedAt: ISODateTime | null;
  resolvedByUserId: UUID | null;
  resolvedAt: ISODateTime | null;
  resolutionNotes: string | null;
}

// --- Saved locations -------------------------------------------------------

export interface SavedLocation extends Timestamps {
  id: UUID;
  customerId: UUID;
  label: string;
  kind: 'home' | 'work' | 'other';
  address: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
}
