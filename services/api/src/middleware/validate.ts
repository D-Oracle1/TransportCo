import type { RequestHandler } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { AppError } from '../lib/errors';

/**
 * Request validation.
 *
 * The parsed value REPLACES the raw input, so handlers only ever see data that
 * matched the schema — coerced, trimmed and typed. An unvalidated `req.body`
 * never reaches a service.
 */

function toDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

function validationError(error: ZodError): AppError {
  return new AppError({
    code: 'validation_failed',
    message: 'Please check the highlighted fields',
    details: toDetails(error),
  });
}

export function validateBody<T>(schema: ZodSchema<T>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(validationError(result.error));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(validationError(result.error));
      return;
    }
    // Express 5 makes req.query a getter; assign through a property descriptor
    // so this works on both major versions.
    Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
    next();
  };
}

export function validateParams<T>(schema: ZodSchema<T>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      next(validationError(result.error));
      return;
    }
    Object.defineProperty(req, 'params', { value: result.data, writable: true, configurable: true });
    next();
  };
}
