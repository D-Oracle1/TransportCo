import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors';
import { clientIp } from '../lib/http';
import { env } from '../config';

/**
 * Rate limiting.
 *
 * An in-process fixed-window counter, which is the right shape for a single
 * pilot instance. When the API runs on more than one node this must move to
 * Redis — the interface below is deliberately narrow so that swap is a change
 * to `Store` and nothing else.
 *
 * The strict limiters matter most: OTP and login endpoints are where an
 * attacker enumerates Nigerian phone numbers, and where SMS costs turn an
 * attack into a bill.
 */

interface Counter {
  count: number;
  resetAt: number;
}

class MemoryStore {
  private readonly counters = new Map<string, Counter>();
  private lastSweep = Date.now();

  hit(key: string, windowMs: number): Counter {
    const now = Date.now();
    this.sweep(now);

    const existing = this.counters.get(key);
    if (!existing || existing.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.counters.set(key, fresh);
      return fresh;
    }

    existing.count += 1;
    return existing;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) this.counters.delete(key);
    }
  }
}

const store = new MemoryStore();

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  /** Distinguishes limiter buckets so login and OTP do not share a budget. */
  bucket: string;
  /** Defaults to the caller's user id when authenticated, else their IP. */
  keyResolver?: (req: Parameters<RequestHandler>[0]) => string;
  message?: string;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const windowMs = options.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const max = options.max ?? env.RATE_LIMIT_MAX;

  return (req, res, next) => {
    const identity = options.keyResolver
      ? options.keyResolver(req)
      : (req.claims?.sub ?? clientIp(req) ?? 'anonymous');

    const counter = store.hit(`${options.bucket}:${identity}`, windowMs);
    const remaining = Math.max(0, max - counter.count);

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(counter.resetAt / 1000)));

    if (counter.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((counter.resetAt - Date.now()) / 1000));
      next(
        new AppError({
          code: 'rate_limited',
          message: options.message ?? 'Too many requests. Please slow down.',
          retryAfterSeconds,
        }),
      );
      return;
    }

    next();
  };
}

/** Default budget for authenticated API traffic. */
export const standardRateLimit = rateLimit({ bucket: 'standard' });

/** Sign-in and password reset: tight, and keyed by IP. */
export const authRateLimit = rateLimit({
  bucket: 'auth',
  windowMs: 15 * 60_000,
  max: 10,
  keyResolver: (req) => clientIp(req) ?? 'anonymous',
  message: 'Too many attempts. Try again in a few minutes.',
});

/** OTP requests: keyed by the target phone number, because that is what costs money. */
export const otpRateLimit = rateLimit({
  bucket: 'otp',
  windowMs: 15 * 60_000,
  max: 5,
  keyResolver: (req) => String((req.body as { phone?: string })?.phone ?? clientIp(req) ?? 'anonymous'),
  message: 'You have requested too many codes. Try again shortly.',
});

/** Location pings are frequent by design; the limit only catches a runaway client. */
export const locationRateLimit = rateLimit({
  bucket: 'location',
  windowMs: 60_000,
  max: 120,
});
