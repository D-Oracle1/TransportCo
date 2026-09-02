import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ApiSuccess, Paginated } from '@transportco/types';
import { getContext } from './context';

/**
 * HTTP helpers. Every response leaves through `sendOk` or the error handler, so
 * the envelope shape is guaranteed to be consistent across every endpoint.
 */

export function sendOk<T>(res: Response, data: T, statusCode = 200): void {
  const body: ApiSuccess<T> = {
    ok: true,
    data,
    requestId: getContext()?.requestId ?? 'unknown',
  };
  res.status(statusCode).json(body);
}

export function sendCreated<T>(res: Response, data: T): void {
  sendOk(res, data, 201);
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 * Express 4 does not do this itself, and an unhandled rejection here means a
 * request that hangs until the client times out.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function paginate<T>(items: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  };
}

export function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return req.socket.remoteAddress ?? null;
}

/**
 * Reads a route parameter that the route's own schema has already validated.
 *
 * Express types `req.params` as an open string map, so under
 * `noUncheckedIndexedAccess` every access is `string | undefined`. Rather than
 * scattering non-null assertions through the handlers, this narrows once and
 * fails loudly if a route is ever mounted without the parameter it reads.
 */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | undefined>)[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Route parameter "${name}" is missing — check the route definition`);
  }
  return value;
}
