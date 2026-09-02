import type { PoolClient } from 'pg';
import type { AuditAction } from '@transportco/types';
import { query } from '../db/pool';
import { currentActor, getContext } from '../lib/context';
import { logger } from '../lib/logger';

/**
 * Audit logging.
 *
 * Every sensitive action writes one row here with the actor, the resource and
 * the before/after values. The table is append-only at the database level (see
 * migration 0004) — not by convention, by trigger.
 *
 * When an audit write is part of a business transaction, pass the transaction
 * client. A fare adjustment that succeeds while its audit row is lost is
 * exactly the situation an audit trail exists to prevent.
 */

export interface AuditInput {
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  reason?: string | null;
  /** Overrides the ambient actor — used by background workers. */
  actorUserId?: string | null;
  actorType?: 'customer' | 'driver' | 'admin' | 'system';
}

export async function recordAudit(input: AuditInput, client?: PoolClient): Promise<void> {
  const ambient = currentActor();
  const context = getContext();

  const sql = `
    INSERT INTO audit_logs (
      actor_user_id, actor_role, actor_type, action, resource_type, resource_id,
      previous_value, new_value, reason, ip_address, user_agent, request_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `;

  const params = [
    input.actorUserId !== undefined ? input.actorUserId : ambient.userId,
    ambient.role,
    input.actorType ?? ambient.actorType,
    input.action,
    input.resourceType,
    input.resourceId ?? null,
    input.previousValue ? JSON.stringify(input.previousValue) : null,
    input.newValue ? JSON.stringify(input.newValue) : null,
    input.reason ?? null,
    context?.ipAddress ?? null,
    context?.userAgent ?? null,
    context?.requestId ?? null,
  ];

  try {
    if (client) await client.query(sql, params);
    else await query(sql, params);
  } catch (error) {
    // An audit failure must never swallow the business outcome when it is
    // outside the transaction — but it must be loud.
    logger.error({ err: error, action: input.action }, 'Failed to write audit log');
    if (client) throw error;
  }
}

/**
 * Diff helper: records only the fields that actually changed, so an audit row
 * for "driver reassigned" is not 40 unchanged columns of noise.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { previous: Record<string, unknown>; next: Record<string, unknown> } {
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) {
      previous[key] = before[key];
      next[key] = value;
    }
  }

  return { previous, next };
}
