import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPATCH_WEIGHTS, OPERATIONS_DEFAULTS } from '@transportco/config';
import { computeWorkloadScore, rankCandidates, scoreCandidate, type DispatchDriverInput } from './scoring';

const now = new Date('2026-03-10T10:00:00.000Z');
const pickup = { latitude: 4.8156, longitude: 7.0498 }; // Rumuola, Port Harcourt

const options = {
  weights: DEFAULT_DISPATCH_WEIGHTS,
  maxPickupRadiusMetres: OPERATIONS_DEFAULTS.maxPickupRadiusMetres,
  staleLocationSeconds: OPERATIONS_DEFAULTS.staleLocationSeconds,
  tripDistanceMetres: 12_000,
  now,
};

function driver(overrides: Partial<DispatchDriverInput> = {}): DispatchDriverInput {
  return {
    driverId: 'driver-1',
    fullName: 'Michael Okoro',
    photoUrl: null,
    rating: 4.6,
    state: 'AVAILABLE',
    location: { latitude: 4.8256, longitude: 7.0498 }, // ~1.1 km north
    lastLocationAt: new Date(now.getTime() - 20_000),
    workload: {
      activeTrips: 0,
      scheduledTripsNext4h: 0,
      completedTripsToday: 2,
      onDutyMinutesToday: 120,
      score: 0.2,
    },
    vehicle: { id: 'v1', plateNumber: 'RIV-123-AB', make: 'Toyota', model: 'Corolla', color: 'Silver', year: 2019 },
    licenseExpiry: new Date('2028-01-01T00:00:00.000Z'),
    activeTripCount: 0,
    conflictingScheduledTrips: 0,
    idleSince: new Date(now.getTime() - 30 * 60_000),
    ...overrides,
  };
}

describe('scoreCandidate', () => {
  it('explains every factor it used', () => {
    const candidate = scoreCandidate(driver(), pickup, options);

    expect(candidate.factors).toHaveLength(5);
    for (const factor of candidate.factors) {
      expect(factor.detail.length).toBeGreaterThan(0);
      expect(factor.normalised).toBeGreaterThanOrEqual(0);
      expect(factor.normalised).toBeLessThanOrEqual(1);
    }
    expect(candidate.score).toBeGreaterThan(0);
    expect(candidate.score).toBeLessThanOrEqual(100);
  });

  it('computes a plausible distance and ETA', () => {
    const candidate = scoreCandidate(driver(), pickup, options);

    expect(candidate.distanceToPickupMetres).toBeGreaterThan(900);
    expect(candidate.distanceToPickupMetres).toBeLessThan(1_300);
    expect(candidate.etaToPickupSeconds).toBeGreaterThan(0);
  });

  it('excludes a driver whose location has gone stale', () => {
    const candidate = scoreCandidate(
      driver({ lastLocationAt: new Date(now.getTime() - 10 * 60_000) }),
      pickup,
      options,
    );

    expect(candidate.eligible).toBe(false);
    expect(candidate.exclusionReasons).toContain('stale_location');
  });

  it('excludes offline, suspended, vehicle-less and expired-licence drivers', () => {
    expect(scoreCandidate(driver({ state: 'OFFLINE' }), pickup, options).exclusionReasons).toContain('offline');
    expect(scoreCandidate(driver({ state: 'SUSPENDED' }), pickup, options).exclusionReasons).toContain('suspended');
    expect(scoreCandidate(driver({ vehicle: null }), pickup, options).exclusionReasons).toContain('no_vehicle');
    expect(
      scoreCandidate(driver({ licenseExpiry: new Date('2020-01-01T00:00:00.000Z') }), pickup, options)
        .exclusionReasons,
    ).toContain('license_expired');
  });

  it('excludes a driver with a conflicting scheduled trip', () => {
    const candidate = scoreCandidate(driver({ conflictingScheduledTrips: 1 }), pickup, options);

    expect(candidate.eligible).toBe(false);
    expect(candidate.exclusionReasons).toContain('scheduled_conflict');
  });

  it('excludes a driver beyond the pickup radius', () => {
    const candidate = scoreCandidate(
      driver({ location: { latitude: 6.5244, longitude: 3.3792 } }), // Lagos
      pickup,
      options,
    );

    expect(candidate.exclusionReasons).toContain('out_of_range');
  });
});

describe('rankCandidates', () => {
  it('prefers the slightly further driver who is not saturated', () => {
    // The scenario from the brief: B is closer but heavily loaded, A is 2 km
    // away and idle. Picking B would be the naive "nearest driver wins" answer.
    const driverA = driver({
      driverId: 'A',
      fullName: 'Driver A',
      location: { latitude: 4.8336, longitude: 7.0498 }, // ~2 km
      workload: { activeTrips: 0, scheduledTripsNext4h: 0, completedTripsToday: 1, onDutyMinutesToday: 60, score: 0.1 },
      idleSince: new Date(now.getTime() - 40 * 60_000),
    });

    const driverB = driver({
      driverId: 'B',
      fullName: 'Driver B',
      location: { latitude: 4.8246, longitude: 7.0498 }, // ~1 km
      workload: { activeTrips: 0, scheduledTripsNext4h: 3, completedTripsToday: 11, onDutyMinutesToday: 460, score: 0.9 },
      idleSince: new Date(now.getTime() - 2 * 60_000),
    });

    const { recommended, candidates } = rankCandidates([driverB, driverA], pickup, options);

    expect(recommended?.driverId).toBe('A');
    expect(candidates[0]?.driverId).toBe('A');
    // ...and the closer driver is still shown, so the dispatcher can override.
    expect(candidates.map((candidate) => candidate.driverId)).toContain('B');
  });

  it('returns ineligible drivers with their reasons rather than hiding them', () => {
    const { candidates, recommended } = rankCandidates(
      [driver({ driverId: 'offline', state: 'OFFLINE' })],
      pickup,
      options,
    );

    expect(recommended).toBeNull();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.exclusionReasons.length).toBeGreaterThan(0);
  });

  it('sorts eligible drivers ahead of ineligible ones', () => {
    const { candidates } = rankCandidates(
      [driver({ driverId: 'bad', state: 'OFFLINE' }), driver({ driverId: 'good' })],
      pickup,
      options,
    );

    expect(candidates[0]?.driverId).toBe('good');
  });

  it('is deterministic for equally scored drivers', () => {
    const drivers = [driver({ driverId: 'x' }), driver({ driverId: 'y' })];
    const first = rankCandidates(drivers, pickup, options).candidates.map((candidate) => candidate.driverId);
    const second = rankCandidates(drivers, pickup, options).candidates.map((candidate) => candidate.driverId);

    expect(first).toEqual(second);
  });
});

describe('computeWorkloadScore', () => {
  it('returns zero for a completely idle driver', () => {
    expect(
      computeWorkloadScore({ activeTrips: 0, scheduledTripsNext4h: 0, completedTripsToday: 0, onDutyMinutesToday: 0 }),
    ).toBe(0);
  });

  it('saturates at one for an overloaded driver', () => {
    expect(
      computeWorkloadScore({
        activeTrips: 2,
        scheduledTripsNext4h: 6,
        completedTripsToday: 20,
        onDutyMinutesToday: 600,
      }),
    ).toBe(1);
  });

  it('weights an active trip more heavily than a busy morning', () => {
    const onTrip = computeWorkloadScore({
      activeTrips: 1,
      scheduledTripsNext4h: 0,
      completedTripsToday: 0,
      onDutyMinutesToday: 0,
    });
    const busyMorning = computeWorkloadScore({
      activeTrips: 0,
      scheduledTripsNext4h: 0,
      completedTripsToday: 8,
      onDutyMinutesToday: 240,
    });

    expect(onTrip).toBeGreaterThan(busyMorning);
  });
});
