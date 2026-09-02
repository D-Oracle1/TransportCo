import type { GeoPoint, ISODateTime, UUID } from './common';
import type { DriverWorkload, VehicleSummary } from './identity';

/**
 * Dispatch produces a RANKED RECOMMENDATION, not a decision. A human assigns
 * (or accepts the recommendation). Every factor is weighted and every score is
 * explainable, because a dispatcher who cannot see why will not trust it.
 */

export interface DispatchWeights {
  proximity: number;
  workload: number;
  rating: number;
  idleTime: number;
  /** Reserved for the EV fleet: battery range headroom vs trip distance. */
  vehicleReadiness: number;
}

export interface DispatchCandidateFactor {
  code: 'proximity' | 'workload' | 'rating' | 'idle_time' | 'vehicle_readiness';
  label: string;
  /** Normalised 0..1, higher is better. */
  normalised: number;
  weight: number;
  contribution: number;
  /** Human-readable, e.g. "2.4 km away". */
  detail: string;
}

export type DispatchExclusionReason =
  | 'not_available'
  | 'offline'
  | 'suspended'
  | 'no_vehicle'
  | 'license_expired'
  | 'scheduled_conflict'
  | 'active_trip'
  | 'out_of_range'
  | 'stale_location';

export interface DispatchCandidate {
  driverId: UUID;
  fullName: string;
  photoUrl: string | null;
  rating: number | null;
  location: GeoPoint | null;
  lastLocationAt: ISODateTime | null;
  distanceToPickupMetres: number | null;
  etaToPickupSeconds: number | null;
  workload: DriverWorkload;
  vehicle: VehicleSummary | null;
  /** 0..100. */
  score: number;
  factors: DispatchCandidateFactor[];
  eligible: boolean;
  exclusionReasons: DispatchExclusionReason[];
}

export interface DispatchRecommendation {
  tripId: UUID;
  generatedAt: ISODateTime;
  candidates: DispatchCandidate[];
  /** The top eligible candidate, or null when nobody can take the trip. */
  recommended: DispatchCandidate | null;
  weights: DispatchWeights;
}

export type AssignmentReason =
  | 'initial_assignment'
  | 'admin_override'
  | 'driver_unavailable'
  | 'driver_no_show'
  | 'schedule_conflict'
  | 'customer_request'
  | 'system_reassignment';

export interface TripAssignment {
  id: UUID;
  tripId: UUID;
  driverId: UUID;
  vehicleId: UUID | null;
  assignedByUserId: UUID | null;
  reason: AssignmentReason;
  /** Score at assignment time, kept so dispatch quality can be reviewed later. */
  recommendationScore: number | null;
  /** True when a human picked someone other than the recommendation. */
  wasOverride: boolean;
  active: boolean;
  releasedAt: ISODateTime | null;
  createdAt: ISODateTime;
}
