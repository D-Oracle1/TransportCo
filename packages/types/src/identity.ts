import type { ISODateTime, Timestamps, UUID } from './common';

/**
 * A single `users` row backs every human in the system. `principalType` says
 * which profile table extends it. This keeps auth, audit logging and RBAC
 * uniform across customers, employees and drivers.
 */
export type PrincipalType = 'customer' | 'employee';

export type UserStatus = 'active' | 'suspended' | 'deactivated' | 'pending_verification';

export interface User extends Timestamps {
  id: UUID;
  principalType: PrincipalType;
  fullName: string;
  email: string | null;
  phone: string;
  status: UserStatus;
  phoneVerifiedAt: ISODateTime | null;
  emailVerifiedAt: ISODateTime | null;
  lastLoginAt: ISODateTime | null;
}

export interface NotificationPreferences {
  push: boolean;
  sms: boolean;
  email: boolean;
  whatsapp: boolean;
}

export interface Customer extends Timestamps {
  id: UUID;
  userId: UUID;
  /** Customer-facing reference, e.g. CUS-000142. */
  reference: string;
  referralCode: string;
  referredByCustomerId: UUID | null;
  rating: number | null;
  totalTrips: number;
  /** Convenience flag; the authoritative value lives in outstanding_balances. */
  hasOutstandingBalance: boolean;
  notificationPreferences: NotificationPreferences;
}

export type EmploymentStatus = 'active' | 'probation' | 'suspended' | 'terminated' | 'on_leave';

export interface Employee extends Timestamps {
  id: UUID;
  userId: UUID;
  /** HR reference, e.g. EMP-0007. */
  employeeId: string;
  jobTitle: string;
  employmentStatus: EmploymentStatus;
  employmentDate: ISODateTime;
  terminationDate: ISODateTime | null;
  /** Monthly basic salary in minor units. Payroll-sensitive; HR/Finance only. */
  basicSalaryMinor: number;
  photoUrl: string | null;
}

/**
 * Driver states. OFFLINE is the resting state; AVAILABLE means dispatchable.
 * State is server-owned: the app requests a transition, the API decides.
 */
export type DriverState =
  | 'OFFLINE'
  | 'ONLINE'
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'PICKING_UP'
  | 'ARRIVED'
  | 'ON_TRIP'
  | 'ON_BREAK'
  | 'SUSPENDED';

export interface Driver extends Timestamps {
  id: UUID;
  employeeId: UUID;
  licenseNumber: string;
  licenseExpiry: ISODateTime;
  licenseClass: string | null;
  state: DriverState;
  /** Vehicle currently allocated to this driver, if any. */
  assignedVehicleId: UUID | null;
  rating: number | null;
  ratingCount: number;
  totalTrips: number;
  lastLocationAt: ISODateTime | null;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastHeading: number | null;
}

export interface VehicleSummary {
  id: UUID;
  plateNumber: string;
  make: string;
  model: string;
  color: string;
  year: number | null;
}

export interface DriverWorkload {
  activeTrips: number;
  scheduledTripsNext4h: number;
  completedTripsToday: number;
  onDutyMinutesToday: number;
  /** 0 (idle) .. 1 (saturated). */
  score: number;
}

/** Read model joining user + employee + driver, used by admin and dispatch. */
export interface DriverProfile {
  driver: Driver;
  employee: Employee;
  user: Pick<User, 'id' | 'fullName' | 'phone' | 'email' | 'status'>;
  vehicle: VehicleSummary | null;
  workload?: DriverWorkload;
}

/** What the customer is shown once a driver is assigned. Deliberately minimal. */
export interface AssignedDriverCard {
  driverId: UUID;
  fullName: string;
  photoUrl: string | null;
  rating: number | null;
  /** Masked phone for in-trip contact. */
  maskedPhone: string;
  vehicle: VehicleSummary | null;
}
