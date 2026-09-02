import type { AuthClaims, Permission, RoleKey } from '@transportco/types';
import { ROLE_PERMISSIONS } from '@transportco/types';

/**
 * Authorisation helpers.
 *
 * Two rules, both load-bearing:
 *
 *  1. Code checks PERMISSIONS, never role names. `if (user.role === 'admin')`
 *     is how a system ends up unable to create a new role without a deploy, and
 *     how a permission quietly leaks to a role that should not have it.
 *
 *  2. Permissions come from the token, which the server minted from the
 *     database. A client-supplied role or permission list is ignored entirely.
 */

export function permissionsForRoles(roleKeys: string[]): Permission[] {
  const set = new Set<Permission>();
  for (const key of roleKeys) {
    const permissions = ROLE_PERMISSIONS[key as RoleKey];
    if (!permissions) continue;
    for (const permission of permissions) set.add(permission);
  }
  return [...set];
}

export function hasPermission(claims: Pick<AuthClaims, 'permissions'>, permission: Permission): boolean {
  return claims.permissions.includes(permission);
}

export function hasAnyPermission(
  claims: Pick<AuthClaims, 'permissions'>,
  permissions: Permission[],
): boolean {
  return permissions.some((permission) => claims.permissions.includes(permission));
}

export function hasAllPermissions(
  claims: Pick<AuthClaims, 'permissions'>,
  permissions: Permission[],
): boolean {
  return permissions.every((permission) => claims.permissions.includes(permission));
}

/**
 * Ownership check for customer-scoped resources.
 *
 * Staff with `customer:read` may read any customer; a customer may only ever
 * read themselves. This is the guard that stops `/trips/{someone-elses-id}`
 * from being an information leak, which is the single most common way a
 * transport app exposes strangers' home addresses.
 */
export function canAccessCustomerResource(
  claims: Pick<AuthClaims, 'permissions' | 'customerId' | 'principalType'>,
  customerId: string,
): boolean {
  if (claims.principalType === 'customer') return claims.customerId === customerId;
  return claims.permissions.includes('customer:read');
}

export function canAccessDriverResource(
  claims: Pick<AuthClaims, 'permissions' | 'driverId' | 'principalType'>,
  driverId: string,
): boolean {
  if (claims.driverId) return claims.driverId === driverId;
  return claims.permissions.includes('driver:read');
}

/**
 * Fields that must be stripped before a payload leaves the API, by audience.
 * Applied by the serialisers so a new field cannot leak by being forgotten.
 */
export const REDACTED_FOR_CUSTOMER = [
  'floorMinor',
  'floor_minor',
  'autoAcceptAtOrAboveMinor',
  'auto_accept_at_minor',
  'internalNote',
  'costModel',
  'cost_model',
  'recommendationScore',
] as const;

export const REDACTED_FOR_DRIVER = [
  ...REDACTED_FOR_CUSTOMER,
  'quotedFareMinor',
  'quoted_fare_minor',
  'negotiation',
  'customerPhone',
  'customer_phone',
] as const;

export function redact<T extends Record<string, unknown>>(payload: T, keys: readonly string[]): Partial<T> {
  const clone: Record<string, unknown> = { ...payload };
  for (const key of keys) delete clone[key];
  return clone as Partial<T>;
}
