import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiFailure } from '@transportco/types';
import { AppError, isAppError } from '../lib/errors';
import { getContext } from '../lib/context';
import { logger } from '../lib/logger';
import { isProduction } from '../config';

/**
 * The single exit point for every failure.
 *
 * Two rules:
 *   - A 5xx never leaks its message. Internal detail goes to the log with the
 *     request id attached; the client gets a generic line and that id.
 *   - Postgres constraint violations are translated into business errors,
 *     because those constraints ARE business rules. A unique-violation on a
 *     phone number should read "an account with this number already exists",
 *     not "duplicate key value violates unique constraint users_phone_unique".
 */

interface PostgresError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

function translatePostgresError(error: PostgresError): AppError | null {
  switch (error.code) {
    case '23505': {
      // unique_violation
      const constraint = error.constraint ?? '';
      if (constraint.includes('users_phone')) {
        return new AppError({
          code: 'conflict',
          message: 'An account with this phone number already exists',
        });
      }
      if (constraint.includes('users_email')) {
        return new AppError({ code: 'conflict', message: 'An account with this email already exists' });
      }
      if (constraint.includes('trip_assignments_one_active')) {
        return new AppError({
          code: 'conflict',
          message: 'This trip already has an active driver assignment',
        });
      }
      if (constraint.includes('payments_one_success_per_trip')) {
        return new AppError({ code: 'conflict', message: 'This trip has already been paid' });
      }
      if (constraint.includes('idempotency')) {
        return new AppError({
          code: 'idempotency_key_reuse',
          message: 'This request was already processed',
        });
      }
      if (constraint.includes('pricing_rule_sets_single_published')) {
        return new AppError({
          code: 'conflict',
          message: 'Another pricing version is already published for this zone',
        });
      }
      return new AppError({ code: 'conflict', message: 'That record already exists' });
    }

    case '23503': // foreign_key_violation
      return new AppError({ code: 'not_found', message: 'A referenced record does not exist' });

    case '23514': // check_violation
      return new AppError({
        code: 'validation_failed',
        message: 'That change would break a business rule',
        logContext: { constraint: error.constraint },
      });

    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return new AppError({
        code: 'version_conflict',
        message: 'Another change landed at the same time. Please try again.',
      });

    case '57014': // query_canceled (statement timeout)
      return new AppError({ code: 'internal_error', message: 'The request took too long', statusCode: 504 });

    default:
      // Our own guard triggers raise plain exceptions with recognisable text.
      if (error.message?.includes('is locked') || error.message?.includes('is immutable')) {
        return new AppError({ code: 'fare_locked', message: 'This fare is locked and cannot be changed' });
      }
      return null;
  }
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = getContext()?.requestId ?? 'unknown';

  let appError: AppError;

  if (isAppError(error)) {
    appError = error;
  } else if (error instanceof ZodError) {
    appError = new AppError({
      code: 'validation_failed',
      message: 'Please check the highlighted fields',
      details: Object.fromEntries(
        error.issues.map((issue) => [issue.path.join('.') || '_', [issue.message]]),
      ),
    });
  } else if (error instanceof Error && error.name === 'InvalidTripTransition') {
    appError = new AppError({ code: 'invalid_state_transition', message: error.message });
  } else {
    appError =
      translatePostgresError(error as PostgresError) ??
      new AppError({
        code: 'internal_error',
        message: 'Something went wrong on our side',
        cause: error,
      });
  }

  const logPayload = {
    err: error,
    requestId,
    code: appError.code,
    statusCode: appError.statusCode,
    method: req.method,
    path: req.originalUrl,
    ...appError.logContext,
  };

  if (appError.statusCode >= 500) logger.error(logPayload, 'Request failed');
  else logger.warn(logPayload, 'Request rejected');

  const body: ApiFailure = {
    ok: false,
    error: {
      code: appError.code,
      message:
        appError.expose || !isProduction
          ? appError.message
          : 'Something went wrong on our side. Please try again.',
      ...(appError.details ? { details: appError.details } : {}),
      ...(appError.retryAfterSeconds ? { retryAfterSeconds: appError.retryAfterSeconds } : {}),
    },
    requestId,
  };

  if (appError.retryAfterSeconds) res.setHeader('Retry-After', String(appError.retryAfterSeconds));
  res.status(appError.statusCode).json(body);
};

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiFailure = {
    ok: false,
    error: { code: 'not_found', message: `No route for ${req.method} ${req.originalUrl}` },
    requestId: getContext()?.requestId ?? 'unknown',
  };
  res.status(404).json(body);
};
