import type {
  DispatchCandidate,
  DispatchCandidateFactor,
  DispatchExclusionReason,
  DispatchWeights,
  DriverState,
  DriverWorkload,
  GeoPoint,
  VehicleSummary,
} from '@transportco/types';
import { formatDistance, haversineMetres } from '@transportco/utils';

/**
 * THE DISPATCH RECOMMENDATION ENGINE.
 *
 * The brief is explicit that picking the first available driver is wrong, and
 * it is: the nearest driver is often the one who has already done nine trips
 * today, and burning them out costs more than the two kilometres saved.
 *
 * So this scores every driver across weighted factors and returns a RANKED
 * LIST with the arithmetic exposed. A dispatcher can see "Driver B is closer
 * but heavily loaded; Driver A scores higher overall" and either accept the
 * recommendation or override it — and the override is recorded, so dispatch
 * quality can be reviewed against outcomes later.
 *
 * Pure function: no database, no clock beyond the `now` passed in.
 */

export interface DispatchDriverInput {
  driverId: string;
  fullName: string;
  photoUrl: string | null;
  rating: number | null;
  state: DriverState;
  location: GeoPoint | null;
  lastLocationAt: Date | null;
  workload: DriverWorkload;
  vehicle: VehicleSummary | null;
  licenseExpiry: Date;
  /** Trips currently occupying this driver. */
  activeTripCount: number;
  /** Scheduled pickups that would collide with this trip. */
  conflictingScheduledTrips: number;
  /** When the driver last finished a trip; used for fair rotation. */
  idleSince: Date | null;
  /** EV only. Null for the current combustion fleet. */
  batteryPercent?: number | null;
  estimatedRangeMetres?: number | null;
}

export interface DispatchOptions {
  weights: DispatchWeights;
  maxPickupRadiusMetres: number;
  staleLocationSeconds: number;
  /** Trip distance, used for the EV range check. */
  tripDistanceMetres: number;
  now: Date;
  /** Rough city speed used to turn straight-line distance into a usable ETA. */
  averageSpeedMps?: number;
}

const DEFAULT_AVERAGE_SPEED_MPS = 8.3; // ~30 km/h through Port Harcourt traffic
const UNRATED_DRIVER_SCORE = 0.6; // a new driver is neither punished nor favoured
const IDLE_SATURATION_MINUTES = 45;

function eligibility(driver: DispatchDriverInput, options: DispatchOptions): DispatchExclusionReason[] {
  const reasons: DispatchExclusionReason[] = [];

  if (driver.state === 'SUSPENDED') reasons.push('suspended');
  if (driver.state === 'OFFLINE') reasons.push('offline');
  if (!['AVAILABLE', 'ONLINE'].includes(driver.state)) {
    if (driver.state !== 'OFFLINE' && driver.state !== 'SUSPENDED') reasons.push('not_available');
  }
  if (driver.activeTripCount > 0) reasons.push('active_trip');
  if (!driver.vehicle) reasons.push('no_vehicle');
  if (driver.licenseExpiry.getTime() <= options.now.getTime()) reasons.push('license_expired');
  if (driver.conflictingScheduledTrips > 0) reasons.push('scheduled_conflict');

  if (!driver.location || !driver.lastLocationAt) {
    reasons.push('stale_location');
  } else {
    const ageSeconds = (options.now.getTime() - driver.lastLocationAt.getTime()) / 1000;
    // A driver whose phone stopped reporting is not dispatchable: we would be
    // promising the customer an ETA computed from a position we cannot trust.
    if (ageSeconds > options.staleLocationSeconds) reasons.push('stale_location');
  }

  return reasons;
}

function normaliseProximity(distanceMetres: number | null, maxRadiusMetres: number): number {
  if (distanceMetres === null) return 0;
  if (distanceMetres >= maxRadiusMetres) return 0;
  return 1 - distanceMetres / maxRadiusMetres;
}

function normaliseIdle(idleSince: Date | null, now: Date): number {
  if (!idleSince) return 0.5; // unknown: neutral
  const idleMinutes = (now.getTime() - idleSince.getTime()) / 60_000;
  return Math.min(1, Math.max(0, idleMinutes / IDLE_SATURATION_MINUTES));
}

function normaliseVehicleReadiness(driver: DispatchDriverInput, tripDistanceMetres: number): number {
  // Combustion fleet: readiness is not a differentiator today.
  if (driver.batteryPercent == null && driver.estimatedRangeMetres == null) return 1;

  if (driver.estimatedRangeMetres != null && tripDistanceMetres > 0) {
    // Want comfortable headroom: the trip plus a return leg plus a margin.
    const required = tripDistanceMetres * 2.2;
    return Math.min(1, driver.estimatedRangeMetres / Math.max(required, 1));
  }

  return Math.min(1, (driver.batteryPercent ?? 0) / 100);
}

export function scoreCandidate(
  driver: DispatchDriverInput,
  pickup: GeoPoint,
  options: DispatchOptions,
): DispatchCandidate {
  const exclusionReasons = eligibility(driver, options);

  const distanceToPickupMetres = driver.location ? haversineMetres(driver.location, pickup) : null;

  if (distanceToPickupMetres !== null && distanceToPickupMetres > options.maxPickupRadiusMetres) {
    exclusionReasons.push('out_of_range');
  }

  const speed = options.averageSpeedMps ?? DEFAULT_AVERAGE_SPEED_MPS;
  const etaToPickupSeconds =
    distanceToPickupMetres === null ? null : Math.round((distanceToPickupMetres * 1.3) / speed);

  const normalised = {
    proximity: normaliseProximity(distanceToPickupMetres, options.maxPickupRadiusMetres),
    // A saturated driver scores 0; an idle one scores 1.
    workload: 1 - Math.min(1, Math.max(0, driver.workload.score)),
    rating: driver.rating === null ? UNRATED_DRIVER_SCORE : (driver.rating - 1) / 4,
    idleTime: normaliseIdle(driver.idleSince, options.now),
    vehicleReadiness: normaliseVehicleReadiness(driver, options.tripDistanceMetres),
  };

  const factors: DispatchCandidateFactor[] = [
    {
      code: 'proximity',
      label: 'Distance from pickup',
      normalised: normalised.proximity,
      weight: options.weights.proximity,
      contribution: normalised.proximity * options.weights.proximity,
      detail: distanceToPickupMetres === null ? 'No recent location' : `${formatDistance(distanceToPickupMetres)} away`,
    },
    {
      code: 'workload',
      label: 'Current workload',
      normalised: normalised.workload,
      weight: options.weights.workload,
      contribution: normalised.workload * options.weights.workload,
      detail: `${driver.workload.completedTripsToday} trips today, ${driver.workload.scheduledTripsNext4h} scheduled`,
    },
    {
      code: 'rating',
      label: 'Customer rating',
      normalised: normalised.rating,
      weight: options.weights.rating,
      contribution: normalised.rating * options.weights.rating,
      detail: driver.rating === null ? 'Not yet rated' : `${driver.rating.toFixed(1)} stars`,
    },
    {
      code: 'idle_time',
      label: 'Time since last trip',
      normalised: normalised.idleTime,
      weight: options.weights.idleTime,
      contribution: normalised.idleTime * options.weights.idleTime,
      detail: driver.idleSince
        ? `Idle ${Math.round((options.now.getTime() - driver.idleSince.getTime()) / 60_000)} min`
        : 'Unknown',
    },
    {
      code: 'vehicle_readiness',
      label: 'Vehicle readiness',
      normalised: normalised.vehicleReadiness,
      weight: options.weights.vehicleReadiness,
      contribution: normalised.vehicleReadiness * options.weights.vehicleReadiness,
      detail:
        driver.batteryPercent == null
          ? (driver.vehicle ? `${driver.vehicle.make} ${driver.vehicle.model}` : 'No vehicle')
          : `Battery ${driver.batteryPercent}%`,
    },
  ];

  const weightTotal = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const rawScore = factors.reduce((sum, factor) => sum + factor.contribution, 0);
  const score = weightTotal > 0 ? Math.round((rawScore / weightTotal) * 10_000) / 100 : 0;

  return {
    driverId: driver.driverId,
    fullName: driver.fullName,
    photoUrl: driver.photoUrl,
    rating: driver.rating,
    location: driver.location,
    lastLocationAt: driver.lastLocationAt ? driver.lastLocationAt.toISOString() : null,
    distanceToPickupMetres,
    etaToPickupSeconds,
    workload: driver.workload,
    vehicle: driver.vehicle,
    score,
    factors,
    eligible: exclusionReasons.length === 0,
    exclusionReasons,
  };
}

/**
 * Rank drivers for a pickup. Ineligible drivers are RETURNED, not dropped —
 * a dispatcher looking at an empty board needs to see that all four drivers
 * are excluded and precisely why, rather than an unexplained blank.
 */
export function rankCandidates(
  drivers: DispatchDriverInput[],
  pickup: GeoPoint,
  options: DispatchOptions,
): { candidates: DispatchCandidate[]; recommended: DispatchCandidate | null } {
  const candidates = drivers
    .map((driver) => scoreCandidate(driver, pickup, options))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      // Deterministic tie-break so two dispatchers see the same order.
      return (a.distanceToPickupMetres ?? Infinity) - (b.distanceToPickupMetres ?? Infinity);
    });

  const recommended = candidates.find((candidate) => candidate.eligible) ?? null;
  return { candidates, recommended };
}

/**
 * Workload score, 0 (idle) to 1 (saturated).
 *
 * Weighted toward what actually exhausts a driver: hours behind the wheel
 * matter more than trip count, and a full upcoming schedule matters more than
 * a busy morning that is already finished.
 */
export function computeWorkloadScore(input: {
  activeTrips: number;
  scheduledTripsNext4h: number;
  completedTripsToday: number;
  onDutyMinutesToday: number;
}): number {
  const activeComponent = Math.min(1, input.activeTrips) * 0.4;
  const scheduledComponent = Math.min(1, input.scheduledTripsNext4h / 3) * 0.25;
  const completedComponent = Math.min(1, input.completedTripsToday / 12) * 0.15;
  const hoursComponent = Math.min(1, input.onDutyMinutesToday / 480) * 0.2;

  const score = activeComponent + scheduledComponent + completedComponent + hoursComponent;
  return Math.round(Math.min(1, score) * 100) / 100;
}
