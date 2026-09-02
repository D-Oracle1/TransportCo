import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@transportco/types';
import {
  canAccessCustomerResource,
  canAccessDriverResource,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  permissionsForRoles,
  redact,
} from './access';

describe('permissionsForRoles', () => {
  it('unions the permissions of several roles', () => {
    const permissions = permissionsForRoles(['dispatcher', 'finance']);

    expect(permissions).toContain('trip:assign_driver');
    expect(permissions).toContain('payment:refund');
  });

  it('deduplicates overlapping permissions', () => {
    const permissions = permissionsForRoles(['dispatcher', 'operations_manager']);

    expect(new Set(permissions).size).toBe(permissions.length);
  });

  it('ignores unknown roles rather than throwing', () => {
    expect(permissionsForRoles(['not_a_role'])).toEqual([]);
  });
});

describe('separation of duty in the seeded roles', () => {
  it('does not let a dispatcher touch money or payroll', () => {
    const dispatcher = ROLE_PERMISSIONS.dispatcher;

    expect(dispatcher).not.toContain('payment:refund');
    expect(dispatcher).not.toContain('payroll:write');
    expect(dispatcher).not.toContain('pricing:write');
    expect(dispatcher).not.toContain('fare:adjust_locked');
  });

  it('lets a dispatcher answer offers but not break the pricing floor', () => {
    // Offers expire in five minutes; the person on the board has to be able to
    // reply. Going below the floor stays a management decision.
    const dispatcher = ROLE_PERMISSIONS.dispatcher;

    expect(dispatcher).toContain('negotiation:respond');
    expect(dispatcher).not.toContain('negotiation:override_floor');
  });

  it('does not let finance change pricing', () => {
    expect(ROLE_PERMISSIONS.finance).toContain('payment:refund');
    expect(ROLE_PERMISSIONS.finance).not.toContain('pricing:write');
  });

  it('does not let HR see customer PII', () => {
    expect(ROLE_PERMISSIONS.hr).toContain('payroll:write');
    expect(ROLE_PERMISSIONS.hr).not.toContain('customer:read_pii');
  });

  it('gives management read access with no operational write access', () => {
    const management = ROLE_PERMISSIONS.management;

    expect(management).toContain('report:read');
    expect(management.some((permission) => permission.endsWith(':write'))).toBe(false);
    expect(management).not.toContain('trip:assign_driver');
  });

  it('grants a driver no administrative permission at all', () => {
    expect(ROLE_PERMISSIONS.driver).toEqual([]);
  });

  it('reserves payroll approval so it cannot be self-granted', () => {
    // Only super admin holds approve; HR prepares, someone else signs off.
    expect(ROLE_PERMISSIONS.hr).not.toContain('payroll:approve');
    expect(ROLE_PERMISSIONS.super_admin).toContain('payroll:approve');
  });
});

describe('permission checks', () => {
  const claims = { permissions: permissionsForRoles(['dispatcher']) };

  it('checks a single permission', () => {
    expect(hasPermission(claims, 'trip:assign_driver')).toBe(true);
    expect(hasPermission(claims, 'payroll:approve')).toBe(false);
  });

  it('checks any and all', () => {
    expect(hasAnyPermission(claims, ['payroll:approve', 'trip:read'])).toBe(true);
    expect(hasAllPermissions(claims, ['payroll:approve', 'trip:read'])).toBe(false);
  });
});

describe('resource ownership', () => {
  it('lets a customer reach only their own records', () => {
    const customer = { principalType: 'customer' as const, customerId: 'c1', permissions: [] };

    expect(canAccessCustomerResource(customer, 'c1')).toBe(true);
    expect(canAccessCustomerResource(customer, 'c2')).toBe(false);
  });

  it('lets staff with customer:read reach any customer', () => {
    const agent = {
      principalType: 'employee' as const,
      permissions: permissionsForRoles(['customer_support']),
    };

    expect(canAccessCustomerResource(agent, 'anyone')).toBe(true);
  });

  it('lets a driver reach only their own assignments', () => {
    const driver = { principalType: 'employee' as const, driverId: 'd1', permissions: [] };

    expect(canAccessDriverResource(driver, 'd1')).toBe(true);
    expect(canAccessDriverResource(driver, 'd2')).toBe(false);
  });
});

describe('redact', () => {
  it('strips internal fields from a payload', () => {
    const payload = { totalMinor: 800_000, floorMinor: 680_000, internalNote: 'floor is 6800' };
    const safe = redact(payload, ['floorMinor', 'internalNote']);

    expect(safe).toEqual({ totalMinor: 800_000 });
  });
});
