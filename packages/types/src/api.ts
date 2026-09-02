import type { Permission, RoleKey } from './rbac';
import type { ISODateTime, UUID } from './common';

/**
 * Every API response uses this envelope so clients have exactly one shape to
 * handle. Errors carry a stable machine `code` — clients switch on the code,
 * never on the message text.
 */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    /** Field-level validation detail, keyed by dotted path. */
    details?: Record<string, string[]>;
    /** Present on 429 and on retryable provider errors. */
    retryAfterSeconds?: number;
  };
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export const API_ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'invalid_credentials',
  'token_expired',
  'forbidden',
  'not_found',
  'conflict',
  'version_conflict',
  'rate_limited',
  'idempotency_key_reuse',
  'account_suspended',
  'phone_not_verified',
  'otp_invalid',
  'otp_expired',
  'otp_throttled',
  'outstanding_balance',
  'invalid_state_transition',
  'fare_locked',
  'quote_expired',
  'offer_expired',
  'negotiation_closed',
  'negotiation_limit_reached',
  'offer_below_floor',
  'no_driver_available',
  'driver_unavailable',
  'payment_failed',
  'payment_verification_failed',
  'webhook_signature_invalid',
  'provider_unavailable',
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Decoded access-token claims. The server never trusts a client-supplied role. */
export interface AuthClaims {
  sub: UUID;
  principalType: 'customer' | 'employee';
  /** Present for staff and drivers. */
  roles: (RoleKey | string)[];
  permissions: Permission[];
  /** Present when the principal is a driver. */
  driverId?: UUID;
  /** Present when the principal is a customer. */
  customerId?: UUID;
  sessionId: UUID;
  iat: number;
  exp: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: ISODateTime;
  tokenType: 'Bearer';
}

export interface AuthenticatedSession {
  tokens: AuthTokens;
  user: {
    id: UUID;
    fullName: string;
    email: string | null;
    phone: string;
    principalType: 'customer' | 'employee';
    status: string;
    customerId?: UUID;
    driverId?: UUID;
    employeeId?: UUID;
    roles: string[];
    permissions: Permission[];
  };
}
