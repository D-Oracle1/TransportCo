import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config';
import { logger } from '../lib/logger';

/**
 * PostgreSQL access.
 *
 * Two decisions worth stating:
 *
 *  1. BIGINT is parsed as a JavaScript number, not a string. Every BIGINT in
 *     this schema is money in kobo or a count. A ₦10,000,000 fare is 10^9 kobo,
 *     nine orders of magnitude below Number.MAX_SAFE_INTEGER, so precision is
 *     never at risk — and returning strings would push string arithmetic into
 *     the pricing paths, which is exactly how money bugs start.
 *
 *  2. There is no ORM. The business logic here is transactional and
 *     concurrency-sensitive (fare locking, assignment races, webhook
 *     idempotency); hand-written SQL keeps the locking and the row counts
 *     visible instead of hidden behind a builder.
 */

// int8 / BIGINT
types.setTypeParser(20, (value) => Number.parseInt(value, 10));
// numeric — used for ratings and multipliers, all small and safe as floats.
types.setTypeParser(1700, (value) => Number.parseFloat(value));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // A query that hangs holds a connection hostage; fail it and free the pool.
  statement_timeout: 15_000,
  query_timeout: 15_000,
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'Unexpected error on an idle database client');
});

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool,
): Promise<T[]> {
  const started = Date.now();
  const result = await client.query<T>(text, params);
  const elapsed = Date.now() - started;

  // Slow-query visibility matters more than usual here: the live operations map
  // polls, and a slow dispatch query degrades the whole board.
  if (elapsed > 500) {
    logger.warn({ elapsedMs: elapsed, sql: text.slice(0, 200) }, 'Slow query');
  }

  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool,
): Promise<T | null> {
  const rows = await query<T>(text, params, client);
  return rows[0] ?? null;
}

/**
 * Run a unit of work in a transaction.
 *
 * Used wherever more than one row must change together — locking a fare and
 * writing its history, applying a payment and awarding loyalty points,
 * assigning a driver and releasing the previous assignment. A partial write in
 * any of those is a support ticket at best and a financial discrepancy at worst.
 */
export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
  options: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${(options.isolation ?? 'read committed').toUpperCase()}`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError) => {
      logger.error({ err: rollbackError }, 'Rollback failed');
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Advisory lock helper for cross-request serialisation that is not tied to one
 * row — for example, "only one dispatcher may be assigning this trip right
 * now". Released automatically when the transaction ends.
 */
export async function advisoryLock(client: PoolClient, namespace: number, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [namespace, key]);
}

export const LOCK_NAMESPACE = {
  TRIP: 1,
  NEGOTIATION: 2,
  PAYMENT: 3,
  DISPATCH: 4,
  PAYROLL: 5,
} as const;

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Database health check failed');
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
