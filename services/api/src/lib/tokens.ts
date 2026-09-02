import jwt, { type SignOptions } from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthClaims, Permission } from '@transportco/types';
import { env } from '../config';
import { AppError } from './errors';

/**
 * Token minting and verification.
 *
 * Access tokens are short-lived (15 minutes) and carry the caller's permissions
 * so authorisation needs no database round trip. Refresh tokens are long-lived,
 * opaque, and stored ONLY as a SHA-256 hash — a database dump must not yield
 * usable sessions.
 *
 * The permissions in a token are the ones the server looked up at sign-in. A
 * client-supplied role or permission list is never read anywhere in this
 * codebase.
 */

const ISSUER = 'transportco-api';

export interface AccessTokenInput {
  userId: string;
  principalType: 'customer' | 'employee';
  roles: string[];
  permissions: Permission[];
  sessionId: string;
  customerId?: string;
  driverId?: string;
}

export function signAccessToken(input: AccessTokenInput): { token: string; expiresAt: Date } {
  const payload = {
    principalType: input.principalType,
    roles: input.roles,
    permissions: input.permissions,
    sessionId: input.sessionId,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.driverId ? { driverId: input.driverId } : {}),
  };

  const options: SignOptions = {
    subject: input.userId,
    issuer: ISSUER,
    expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'],
    algorithm: 'HS256',
  };

  const token = jwt.sign(payload, env.JWT_SECRET, options);
  const decoded = jwt.decode(token) as { exp: number };

  return { token, expiresAt: new Date(decoded.exp * 1000) };
}

export function verifyAccessToken(token: string): AuthClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: ISSUER,
      algorithms: ['HS256'], // pinned: never let the token choose its own algorithm
    });
    return decoded as unknown as AuthClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError({ code: 'token_expired', message: 'Your session has expired. Sign in again.' });
    }
    throw new AppError({ code: 'unauthenticated', message: 'Invalid authentication token' });
  }
}

/** Opaque refresh token. Only its hash is persisted. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = `${randomUUID()}.${randomUUID()}`.replace(/-/g, '');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Parses "30d", "15m", "3600" into seconds — used for session expiry maths. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);

  const amount = Number.parseInt(match[1]!, 10);
  switch (match[2]) {
    case 'd':
      return amount * 86_400;
    case 'h':
      return amount * 3_600;
    case 'm':
      return amount * 60;
    case 's':
    default:
      return amount;
  }
}
