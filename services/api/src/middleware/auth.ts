import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthClaims, Permission } from '@transportco/types';
import { hasAllPermissions, hasAnyPermission } from '../domain/rbac/access';
import { AppError, forbidden, unauthenticated } from '../lib/errors';
import { getContext } from '../lib/context';
import { verifyAccessToken } from '../lib/tokens';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      claims?: AuthClaims;
    }
  }
}

/**
 * Authentication and authorisation middleware.
 *
 * `authenticate` establishes WHO is calling. `requirePermission` establishes
 * WHAT they may do. Every non-public route mounts both — there is no route in
 * this API that infers authorisation from a URL path or a body field.
 */

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

export const authenticate: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (!token) {
    next(unauthenticated());
    return;
  }

  try {
    const claims = verifyAccessToken(token);
    req.claims = claims;

    // Mirror onto the async context so audit writes deep in the call stack
    // record the actor without every function taking a claims argument.
    const context = getContext();
    if (context) context.claims = claims;

    next();
  } catch (error) {
    next(error);
  }
};

/** Attaches claims when a token is present, but does not demand one. */
export const optionalAuthenticate: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    const claims = verifyAccessToken(token);
    req.claims = claims;
    const context = getContext();
    if (context) context.claims = claims;
  } catch {
    // A bad token on an optional route is simply an anonymous caller.
  }
  next();
};

export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.claims) {
      next(unauthenticated());
      return;
    }
    if (!hasAllPermissions(req.claims, permissions)) {
      next(
        new AppError({
          code: 'forbidden',
          message: 'You do not have permission to do that',
          logContext: { required: permissions, held: req.claims.permissions },
        }),
      );
      return;
    }
    next();
  };
}

export function requireAnyPermission(...permissions: Permission[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.claims) {
      next(unauthenticated());
      return;
    }
    if (!hasAnyPermission(req.claims, permissions)) {
      next(forbidden());
      return;
    }
    next();
  };
}

/** Route is for customers only — staff tokens are rejected, not silently allowed. */
export const requireCustomer: RequestHandler = (req, _res, next) => {
  if (!req.claims) {
    next(unauthenticated());
    return;
  }
  if (req.claims.principalType !== 'customer' || !req.claims.customerId) {
    next(forbidden('This endpoint is for customer accounts'));
    return;
  }
  next();
};

/** Route is for drivers only. */
export const requireDriver: RequestHandler = (req, _res, next) => {
  if (!req.claims) {
    next(unauthenticated());
    return;
  }
  if (!req.claims.driverId) {
    next(forbidden('This endpoint is for driver accounts'));
    return;
  }
  next();
};

/** Convenience accessors that narrow the optional claims for handlers. */
export function claimsOf(req: Request): AuthClaims {
  if (!req.claims) throw unauthenticated();
  return req.claims;
}

export function customerIdOf(req: Request): string {
  const claims = claimsOf(req);
  if (!claims.customerId) throw forbidden('This endpoint is for customer accounts');
  return claims.customerId;
}

export function driverIdOf(req: Request): string {
  const claims = claimsOf(req);
  if (!claims.driverId) throw forbidden('This endpoint is for driver accounts');
  return claims.driverId;
}
