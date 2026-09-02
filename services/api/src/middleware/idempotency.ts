import { createHash } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import { AppError } from '../lib/errors';
import { query, queryOne } from '../db/pool';
import { env } from '../config';
import { logger } from '../lib/logger';

/**
 * Idempotency for unsafe requests.
 *
 * A phone on a Nigerian mobile network drops a response often enough that
 * clients retry routinely. Without this, a retried "create trip" makes two
 * trips and a retried "initialize payment" charges twice.
 *
 * Protocol:
 *   - Client sends `Idempotency-Key` (a UUID it generated).
 *   - First request inserts an `in_progress` row and proceeds.
 *   - A retry while the first is still running gets 409, not a duplicate.
 *   - A retry after completion replays the stored response verbatim.
 *   - The same key with a DIFFERENT body is rejected: that is a client bug, and
 *     silently returning the old response would hide it.
 */

const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT']);

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

export function idempotency(options: { required?: boolean } = {}): RequestHandler {
  return (req, res, next) => {
    if (!IDEMPOTENT_METHODS.has(req.method)) {
      next();
      return;
    }

    const key = req.headers['idempotency-key'];

    if (typeof key !== 'string' || key.length === 0) {
      if (options.required) {
        next(
          new AppError({
            code: 'validation_failed',
            message: 'This request requires an Idempotency-Key header',
          }),
        );
        return;
      }
      next();
      return;
    }

    if (key.length > 200) {
      next(new AppError({ code: 'validation_failed', message: 'Idempotency-Key is too long' }));
      return;
    }

    void handle(key, req, res, next);
  };
}

async function handle(
  key: string,
  req: Parameters<RequestHandler>[0],
  res: Response,
  next: Parameters<RequestHandler>[2],
): Promise<void> {
  const endpoint = `${req.method} ${req.route?.path ?? req.path}`;
  const requestHash = hashBody(req.body);
  const scopedKey = `${req.claims?.sub ?? 'anon'}:${key}`;

  try {
    const existing = await queryOne<{
      state: string;
      request_hash: string;
      response_body: unknown;
      status_code: number | null;
    }>(
      'SELECT state, request_hash, response_body, status_code FROM idempotency_keys WHERE key = $1',
      [scopedKey],
    );

    if (existing) {
      if (existing.request_hash !== requestHash) {
        next(
          new AppError({
            code: 'idempotency_key_reuse',
            message: 'This Idempotency-Key was already used with a different request body',
          }),
        );
        return;
      }

      if (existing.state === 'completed') {
        res.setHeader('Idempotent-Replay', 'true');
        res.status(existing.status_code ?? 200).json(existing.response_body);
        return;
      }

      next(
        new AppError({
          code: 'conflict',
          message: 'A request with this key is still being processed',
          retryAfterSeconds: 2,
        }),
      );
      return;
    }

    await query(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'in_progress', now() + ($5 || ' seconds')::interval)`,
      [scopedKey, req.claims?.sub ?? null, endpoint, requestHash, env.IDEMPOTENCY_TTL_SECONDS],
    );

    // Capture the response so a later retry can replay it byte for byte.
    //
    // The response is SENT ONLY AFTER the record is durable. Writing it
    // fire-and-forget loses a race that clients actually hit: a phone that
    // retries the instant a response arrives can beat the write, and would get
    // a 409 "still processing" instead of its original result. One extra round
    // trip here buys a retry that always replays correctly.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const statusCode = res.statusCode;

      const persist =
        statusCode < 500
          ? query(
              `UPDATE idempotency_keys
                  SET state = 'completed', response_body = $2, status_code = $3, completed_at = now()
                WHERE key = $1`,
              [scopedKey, JSON.stringify(body), statusCode],
            )
          : // A 5xx is not a settled outcome: release the key so a retry can work.
            query('DELETE FROM idempotency_keys WHERE key = $1', [scopedKey]);

      void persist
        .catch((error: unknown) => {
          logger.error({ err: error, key: scopedKey }, 'Failed to persist idempotent response');
        })
        .finally(() => {
          originalJson(body);
        });

      return res;
    };

    next();
  } catch (error) {
    next(error);
  }
}

/** Housekeeping for the scheduler: drop expired keys. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const rows = await query<{ count: string }>(
    'WITH deleted AS (DELETE FROM idempotency_keys WHERE expires_at < now() RETURNING 1) SELECT count(*)::text AS count FROM deleted',
  );
  return Number(rows[0]?.count ?? 0);
}
