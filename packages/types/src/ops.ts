import type { CurrencyCode, ISODateTime, MinorUnits, Timestamps, UUID } from './common';

// --- Vehicles --------------------------------------------------------------

/**
 * Phase 1 has four company vehicles and no fleet-management UI, but vehicles
 * are first-class rows from day one — including the EV telemetry columns the
 * future own-brand fleet will fill in. Adding a screen later must not require a
 * data migration.
 */
export type VehicleStatus = 'active' | 'maintenance' | 'inactive' | 'retired';

export type PowertrainType = 'petrol' | 'diesel' | 'hybrid' | 'electric';

export interface Vehicle extends Timestamps {
  id: UUID;
  plateNumber: string;
  make: string;
  model: string;
  year: number | null;
  color: string;
  seats: number;
  status: VehicleStatus;
  powertrain: PowertrainType;
  vin: string | null;
  /** Currently allocated driver, if any. */
  currentDriverId: UUID | null;

  // Telemetry — populated for EVs, null otherwise. Reserved for Phase 2+.
  batteryPercent: number | null;
  estimatedRangeMetres: number | null;
  chargingStatus: 'idle' | 'charging' | 'discharging' | 'fault' | null;
  odometerMetres: number | null;
  lastTelemetryAt: ISODateTime | null;
  healthStatus: 'ok' | 'attention' | 'critical' | null;
  nextServiceDueAt: ISODateTime | null;
}

// --- Payroll ---------------------------------------------------------------

export type PayrollPeriodStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'cancelled';

export interface PayrollPeriod extends Timestamps {
  id: UUID;
  reference: string;
  periodStart: ISODateTime;
  periodEnd: ISODateTime;
  status: PayrollPeriodStatus;
  currency: CurrencyCode;
  totalGrossMinor: MinorUnits;
  totalDeductionsMinor: MinorUnits;
  totalNetMinor: MinorUnits;
  preparedByUserId: UUID | null;
  approvedByUserId: UUID | null;
  approvedAt: ISODateTime | null;
  paidAt: ISODateTime | null;
  note: string | null;
}

export type PayrollItemType =
  | 'basic_salary'
  | 'allowance'
  | 'bonus'
  | 'overtime'
  | 'deduction'
  | 'penalty';

export interface PayrollItem {
  id: UUID;
  payrollRecordId: UUID;
  type: PayrollItemType;
  label: string;
  /** Positive for earnings, positive for deductions too — the type decides the sign. */
  amountMinor: MinorUnits;
  /** e.g. hours of overtime, number of incidents. */
  quantity: number | null;
  note: string | null;
  createdByUserId: UUID | null;
  createdAt: ISODateTime;
}

/** One employee's slip within a period. */
export interface PayrollRecord extends Timestamps {
  id: UUID;
  periodId: UUID;
  employeeId: UUID;
  currency: CurrencyCode;
  basicSalaryMinor: MinorUnits;
  allowancesMinor: MinorUnits;
  bonusesMinor: MinorUnits;
  overtimeMinor: MinorUnits;
  deductionsMinor: MinorUnits;
  penaltiesMinor: MinorUnits;
  grossMinor: MinorUnits;
  netMinor: MinorUnits;
  status: 'draft' | 'approved' | 'paid';
  paymentStatus: 'unpaid' | 'processing' | 'paid' | 'failed';
  paidAt: ISODateTime | null;
  /** Performance snapshot used to justify bonuses. */
  performance: {
    trips: number;
    distanceMetres: number;
    onDutyMinutes: number;
    averageRating: number | null;
    incidents: number;
  };
}

// --- Audit -----------------------------------------------------------------

export type AuditAction =
  | 'fare.adjusted'
  | 'fare.locked'
  | 'pricing.created'
  | 'pricing.published'
  | 'pricing.archived'
  | 'negotiation.responded'
  | 'negotiation.floor_overridden'
  | 'trip.driver_assigned'
  | 'trip.driver_reassigned'
  | 'trip.cancelled'
  | 'trip.state_forced'
  | 'payment.refunded'
  | 'payment.reconciled'
  | 'balance.written_off'
  | 'customer.suspended'
  | 'customer.reactivated'
  | 'driver.created'
  | 'driver.updated'
  | 'driver.deactivated'
  | 'loyalty.adjusted'
  | 'payroll.approved'
  | 'payroll.paid'
  | 'user.role_changed'
  | 'auth.login_succeeded'
  | 'auth.login_failed'
  | 'settings.updated'
  | 'data.exported';

export interface AuditLogEntry {
  id: UUID;
  actorUserId: UUID | null;
  actorRole: string | null;
  actorType: 'customer' | 'driver' | 'admin' | 'system';
  action: AuditAction;
  resourceType: string;
  resourceId: string | null;
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: ISODateTime;
}

// --- Fraud signals ---------------------------------------------------------

export type FraudSignalCode =
  | 'customer.repeated_cancellations'
  | 'customer.duplicate_device'
  | 'customer.duplicate_phone_pattern'
  | 'customer.loyalty_velocity'
  | 'driver.gps_jump'
  | 'driver.route_deviation'
  | 'driver.completion_without_movement'
  | 'driver.cash_shortfall'
  | 'admin.refund_velocity'
  | 'admin.fare_override_velocity'
  | 'admin.self_approval';

export interface FraudSignal {
  id: UUID;
  code: FraudSignalCode;
  severity: 'info' | 'warning' | 'critical';
  subjectType: 'customer' | 'driver' | 'admin' | 'trip';
  subjectId: UUID;
  tripId: UUID | null;
  details: Record<string, unknown>;
  status: 'open' | 'reviewing' | 'dismissed' | 'confirmed';
  reviewedByUserId: UUID | null;
  reviewedAt: ISODateTime | null;
  createdAt: ISODateTime;
}

// --- Analytics -------------------------------------------------------------

export interface ContributionMarginBreakdown {
  currency: CurrencyCode;
  revenueMinor: MinorUnits;
  discountMinor: MinorUnits;
  refundMinor: MinorUnits;
  energyCostMinor: MinorUnits;
  driverVariableCostMinor: MinorUnits;
  operationalCostMinor: MinorUnits;
  paymentFeeMinor: MinorUnits;
  contributionMarginMinor: MinorUnits;
  marginPercent: number;
}

export interface OperationsKpis {
  totalTrips: number;
  completedTrips: number;
  cancelledTrips: number;
  cancellationRate: number;
  averageFareMinor: MinorUnits;
  averageNegotiatedFareMinor: MinorUnits;
  averageDiscountPercent: number;
  totalDiscountMinor: MinorUnits;
  negotiationAcceptanceRate: number;
  revenueMinor: MinorUnits;
  revenuePerVehicleMinor: MinorUnits;
  revenuePerDriverMinor: MinorUnits;
  newCustomers: number;
  activeCustomers: number;
  returningCustomerRate: number;
  driverUtilisation: number;
  averagePickupSeconds: number;
  averageTripDurationSeconds: number;
  paymentSuccessRate: number;
  supportTicketsOpened: number;
  loyaltyPointsIssued: number;
  loyaltyPointsRedeemed: number;
  contributionMargin: ContributionMarginBreakdown;
}
