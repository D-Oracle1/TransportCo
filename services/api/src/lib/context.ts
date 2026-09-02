import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthClaims } from '@transportco/types';

/**
 * Per-request context, carried implicitly.
 *
 * The audit logger needs the actor, the IP and the request id on every write.
 * Threading those four values through every service signature would make the
 * domain code about plumbing, and — worse — would make it easy to forget one
 * and silently write an audit row with no actor. AsyncLocalStorage keeps them
 * available without polluting the interfaces.
 */
export interface RequestContext {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
  claims: AuthClaims | null;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentActor(): {
  userId: string | null;
  actorType: 'customer' | 'driver' | 'admin' | 'system';
  role: string | null;
} {
  const context = storage.getStore();
  const claims = context?.claims;

  if (!claims) return { userId: null, actorType: 'system', role: null };

  if (claims.principalType === 'customer') {
    return { userId: claims.sub, actorType: 'customer', role: 'customer' };
  }
  if (claims.driverId && claims.roles.length === 0) {
    return { userId: claims.sub, actorType: 'driver', role: 'driver' };
  }
  return { userId: claims.sub, actorType: 'admin', role: claims.roles[0] ?? null };
}
