import type { ApiErrorCode } from '@transportco/types';

/**
 * The single error type crossing module boundaries.
 *
 * Every failure the API returns carries a stable machine `code` from the shared
 * `ApiErrorCode` union, so clients switch on the code and never parse English.
 * The `message` is safe to show a user; anything sensitive goes in `logContext`,
 * which is logged and never serialised to the response.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, string[]>;
  readonly retryAfterSeconds?: number;
  readonly logContext?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(args: {
    code: ApiErrorCode;
    message: string;
    statusCode?: number;
    details?: Record<string, string[]>;
    retryAfterSeconds?: number;
    logContext?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = 'AppError';
    this.code = args.code;
    this.statusCode = args.statusCode ?? defaultStatusFor(args.code);
    this.details = args.details;
    this.retryAfterSeconds = args.retryAfterSeconds;
    this.logContext = args.logContext;
    // 5xx messages are replaced with a generic line before they leave the
    // process: an internal error message is an information leak.
    this.expose = this.statusCode < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

function defaultStatusFor(code: ApiErrorCode): number {
  switch (code) {
    case 'validation_failed':
    case 'offer_below_floor':
    case 'invalid_state_transition':
    case 'negotiation_limit_reached':
      return 400;
    case 'unauthenticated':
    case 'invalid_credentials':
    case 'token_expired':
    case 'otp_invalid':
    case 'otp_expired':
      return 401;
    case 'forbidden':
    case 'account_suspended':
    case 'phone_not_verified':
    case 'outstanding_balance':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
    case 'version_conflict':
    case 'idempotency_key_reuse':
    case 'fare_locked':
    case 'quote_expired':
    case 'offer_expired':
    case 'negotiation_closed':
    case 'driver_unavailable':
      return 409;
    case 'no_driver_available':
      return 422;
    case 'rate_limited':
    case 'otp_throttled':
      return 429;
    case 'provider_unavailable':
      return 503;
    case 'payment_failed':
    case 'payment_verification_failed':
      return 402;
    case 'webhook_signature_invalid':
      return 400;
    case 'internal_error':
    default:
      return 500;
  }
}

// --- Constructors for the failures that come up constantly ------------------

export const notFound = (resource: string, id?: string): AppError =>
  new AppError({
    code: 'not_found',
    message: `${resource} not found`,
    logContext: id ? { resource, id } : { resource },
  });

export const forbidden = (message = 'You do not have permission to do that'): AppError =>
  new AppError({ code: 'forbidden', message });

export const unauthenticated = (message = 'Sign in to continue'): AppError =>
  new AppError({ code: 'unauthenticated', message });

export const conflict = (message: string, code: ApiErrorCode = 'conflict'): AppError =>
  new AppError({ code, message });

export const validationFailed = (
  message: string,
  details?: Record<string, string[]>,
): AppError => new AppError({ code: 'validation_failed', message, details });

export const internalError = (message: string, cause?: unknown): AppError =>
  new AppError({ code: 'internal_error', message, cause, statusCode: 500 });

/**
 * Optimistic-concurrency failure. Raised when two administrators act on the
 * same trip, or when a customer offer and an admin counter collide. The loser
 * is told to refetch rather than being allowed to overwrite silently.
 */
export const versionConflict = (resource: string): AppError =>
  new AppError({
    code: 'version_conflict',
    message: `This ${resource} was changed by someone else. Refresh and try again.`,
  });

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
