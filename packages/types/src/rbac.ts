/**
 * Role-based access control.
 *
 * Permissions are the unit of authorisation — code always checks a permission,
 * never a role name. Roles are bundles of permissions and are stored as data,
 * so operations can create new roles without a deploy. The matrix below is the
 * seeded default set.
 */

export const PERMISSIONS = [
  // Trips & dispatch
  'trip:read',
  'trip:cancel',
  'trip:assign_driver',
  'trip:reassign_driver',
  'trip:force_state',
  // Negotiation
  'negotiation:read',
  'negotiation:respond',
  'negotiation:override_floor',
  // Pricing
  'pricing:read',
  'pricing:write',
  'pricing:publish',
  // Fares after lock
  'fare:adjust_locked',
  // Customers
  'customer:read',
  'customer:write',
  'customer:suspend',
  'customer:read_pii',
  // Drivers / employees
  'driver:read',
  'driver:write',
  'driver:deactivate',
  'employee:read',
  'employee:write',
  // Payments & finance
  'payment:read',
  'payment:refund',
  'payment:reconcile',
  'balance:write_off',
  // Loyalty
  'loyalty:read',
  'loyalty:adjust',
  // Support
  'support:read',
  'support:respond',
  'support:close',
  // Emergency
  'emergency:read',
  'emergency:respond',
  // Payroll
  'payroll:read',
  'payroll:write',
  'payroll:approve',
  // Platform
  'report:read',
  'audit:read',
  'user:manage_roles',
  'settings:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type RoleKey =
  | 'super_admin'
  | 'operations_manager'
  | 'dispatcher'
  | 'finance'
  | 'customer_support'
  | 'hr'
  | 'management'
  | 'driver';

export interface Role {
  id: string;
  key: RoleKey | string;
  name: string;
  description: string;
  /** System roles cannot be deleted or have their key changed. */
  system: boolean;
  permissions: Permission[];
}

/**
 * Seeded role to permission matrix. Deliberate separations of duty:
 *  - Dispatcher moves drivers around but touches no money and no payroll.
 *  - Finance refunds but cannot change pricing (an operations/management call).
 *  - HR owns payroll data but sees no customer PII.
 *  - Management reads broadly, writes nothing operational.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, readonly Permission[]> = {
  super_admin: PERMISSIONS,

  operations_manager: [
    'trip:read',
    'trip:cancel',
    'trip:assign_driver',
    'trip:reassign_driver',
    'trip:force_state',
    'negotiation:read',
    'negotiation:respond',
    'pricing:read',
    'customer:read',
    'customer:write',
    'customer:suspend',
    'driver:read',
    'driver:write',
    'employee:read',
    'payment:read',
    'loyalty:read',
    'support:read',
    'support:respond',
    'emergency:read',
    'emergency:respond',
    'report:read',
    'audit:read',
  ],

  dispatcher: [
    'trip:read',
    'trip:assign_driver',
    'trip:reassign_driver',
    'negotiation:read',
    // A dispatcher answers offers. Offers expire in five minutes, so requiring
    // a manager for routine haggling would mean customers time out waiting.
    // They may NOT hold negotiation:override_floor — trading inside the
    // configured band is dispatch work; breaking the pricing floor is a
    // management decision.
    'negotiation:respond',
    'driver:read',
    'customer:read',
    'emergency:read',
  ],

  finance: [
    'trip:read',
    'payment:read',
    'payment:refund',
    'payment:reconcile',
    'balance:write_off',
    'customer:read',
    'loyalty:read',
    'report:read',
    'audit:read',
  ],

  customer_support: [
    'trip:read',
    'trip:cancel',
    'negotiation:read',
    'customer:read',
    'customer:read_pii',
    'driver:read',
    'payment:read',
    'loyalty:read',
    'support:read',
    'support:respond',
    'support:close',
    'emergency:read',
  ],

  hr: [
    'employee:read',
    'employee:write',
    'driver:read',
    'driver:write',
    'driver:deactivate',
    'payroll:read',
    'payroll:write',
  ],

  management: [
    'trip:read',
    'negotiation:read',
    'pricing:read',
    'customer:read',
    'driver:read',
    'employee:read',
    'payment:read',
    'loyalty:read',
    'support:read',
    'payroll:read',
    'report:read',
    'audit:read',
  ],

  /** Drivers authenticate against the same identity core but hold no admin rights. */
  driver: [],
};
