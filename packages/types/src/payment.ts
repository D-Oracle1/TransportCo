import type { CurrencyCode, ISODateTime, MinorUnits, Timestamps, UUID } from './common';
import type { PaymentMethod } from './trip';

/**
 * Payments are provider-agnostic. Trip logic talks to `PaymentService`, which
 * delegates to an adapter (Paystack, Flutterwave, cash, mock). Card data never
 * touches our servers — we store provider references only.
 */

export type PaymentProvider = 'paystack' | 'flutterwave' | 'cash' | 'mock';

export type PaymentStatus =
  | 'initialized'
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded';

export type PaymentPurpose = 'trip_fare' | 'cancellation_fee' | 'no_show_fee' | 'outstanding_balance';

export interface Payment extends Timestamps {
  id: UUID;
  reference: string;
  customerId: UUID;
  tripId: UUID | null;
  purpose: PaymentPurpose;
  method: PaymentMethod;
  provider: PaymentProvider;
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  status: PaymentStatus;
  /** Provider-side identifier, e.g. Paystack transaction reference. */
  providerReference: string | null;
  /** Set only after a server-side verification call or a verified webhook. */
  verifiedAt: ISODateTime | null;
  verificationSource: 'webhook' | 'polling' | 'manual' | 'driver_confirmation' | null;
  failureReason: string | null;
  /** For cash: the employee who confirmed collection. */
  collectedByDriverId: UUID | null;
  paidAt: ISODateTime | null;
}

/** Append-only ledger of everything a provider told us. Never updated in place. */
export interface PaymentTransaction {
  id: UUID;
  paymentId: UUID;
  provider: PaymentProvider;
  event: string;
  status: PaymentStatus;
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  providerReference: string | null;
  /** Raw provider payload, retained for dispute resolution. */
  rawResponse: Record<string, unknown>;
  /** Idempotency key derived from the provider event id. */
  idempotencyKey: string;
  createdAt: ISODateTime;
}

export interface Refund extends Timestamps {
  id: UUID;
  paymentId: UUID;
  tripId: UUID | null;
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  reason: string;
  status: 'requested' | 'approved' | 'processing' | 'succeeded' | 'failed' | 'rejected';
  requestedByUserId: UUID;
  approvedByUserId: UUID | null;
  providerReference: string | null;
  processedAt: ISODateTime | null;
}

export interface OutstandingBalance extends Timestamps {
  id: UUID;
  customerId: UUID;
  tripId: UUID | null;
  reason: 'cancellation_fee' | 'no_show_fee' | 'failed_payment' | 'manual_adjustment';
  amountMinor: MinorUnits;
  settledAmountMinor: MinorUnits;
  currency: CurrencyCode;
  status: 'outstanding' | 'partially_settled' | 'settled' | 'written_off';
  settledAt: ISODateTime | null;
  writtenOffByUserId: UUID | null;
  note: string | null;
}

/** Saved provider token. We never see or store a PAN. */
export interface CustomerPaymentMethod extends Timestamps {
  id: UUID;
  customerId: UUID;
  provider: PaymentProvider;
  type: 'card' | 'bank_account';
  /** Provider authorization token/code — the only thing we may persist. */
  providerToken: string;
  last4: string | null;
  brand: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  bankName: string | null;
  isDefault: boolean;
  active: boolean;
}

// --- Adapter contracts -----------------------------------------------------

export interface InitializePaymentRequest {
  paymentId: UUID;
  reference: string;
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  customerEmail: string | null;
  customerPhone: string;
  method: PaymentMethod;
  metadata: Record<string, string | number | null>;
  /** Where the provider should send the customer after checkout. */
  callbackUrl?: string;
}

export interface InitializePaymentResult {
  provider: PaymentProvider;
  providerReference: string;
  status: PaymentStatus;
  /** Hosted checkout URL, when the method needs one. */
  authorizationUrl?: string | null;
  /** Dynamic account details for bank transfer, when the provider issues them. */
  bankTransfer?: {
    accountNumber: string;
    accountName: string;
    bankName: string;
    expiresAt: ISODateTime;
  } | null;
  raw: Record<string, unknown>;
}

export interface VerifyPaymentResult {
  provider: PaymentProvider;
  providerReference: string;
  status: PaymentStatus;
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  paidAt: ISODateTime | null;
  raw: Record<string, unknown>;
}

export interface WebhookVerificationInput {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface NormalisedWebhookEvent {
  provider: PaymentProvider;
  /** Stable id used for idempotency — replays are dropped. */
  eventId: string;
  event: string;
  reference: string;
  providerReference: string | null;
  status: PaymentStatus;
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  paidAt: ISODateTime | null;
  raw: Record<string, unknown>;
}
