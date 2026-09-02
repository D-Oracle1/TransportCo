import { describe, expect, it } from 'vitest';
import { TRIP_STATUSES, type TripStatus } from '@transportco/types';
import {
  TERMINAL_STATUSES,
  TRIP_TRANSITIONS,
  allowedTransitions,
  assertTransition,
  canTransition,
  checkTransition,
  customerStatusLabel,
} from './stateMachine';

const ready = {
  hasDriver: true,
  hasFinalFare: true,
  fareLocked: true,
  paymentSettled: true,
};

describe('the happy path', () => {
  it('walks the documented lifecycle end to end', () => {
    const path: Array<[TripStatus, TripStatus, 'customer' | 'driver' | 'admin' | 'system']> = [
      ['REQUESTED', 'FARE_CALCULATED', 'system'],
      ['FARE_CALCULATED', 'NEGOTIATING', 'customer'],
      ['NEGOTIATING', 'FARE_ACCEPTED', 'customer'],
      ['FARE_ACCEPTED', 'FARE_LOCKED', 'system'],
      ['FARE_LOCKED', 'DRIVER_ASSIGNED', 'admin'],
      ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'driver'],
      ['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'driver'],
      ['DRIVER_ARRIVED', 'TRIP_STARTED', 'driver'],
      ['TRIP_STARTED', 'TRIP_COMPLETED', 'driver'],
      ['TRIP_COMPLETED', 'PAYMENT_PENDING', 'system'],
      ['PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'system'],
      ['PAYMENT_COMPLETED', 'REVIEW_PENDING', 'system'],
      ['REVIEW_PENDING', 'COMPLETED', 'customer'],
    ];

    for (const [from, to, actor] of path) {
      expect(checkTransition(from, to, actor, ready).allowed, `${from} -> ${to} as ${actor}`).toBe(true);
    }
  });
});

describe('illegal transitions', () => {
  it('refuses to skip from request straight to a started trip', () => {
    expect(canTransition('REQUESTED', 'TRIP_STARTED')).toBe(false);
  });

  it('refuses to resurrect a cancelled trip', () => {
    expect(allowedTransitions('CANCELLED')).toHaveLength(0);
    expect(allowedTransitions('EXPIRED')).toHaveLength(0);
  });

  it('throws on an illegal transition', () => {
    expect(() => assertTransition('COMPLETED', 'TRIP_STARTED', 'admin', ready)).toThrow(
      /cannot move from COMPLETED to TRIP_STARTED/,
    );
  });
});

describe('actor rules', () => {
  it('does not let a driver lock a fare', () => {
    const result = checkTransition('FARE_ACCEPTED', 'FARE_LOCKED', 'driver', ready);

    expect(result.allowed).toBe(false);
    expect(result.failure?.code).toBe('actor_not_permitted');
  });

  it('does not let a customer start their own trip', () => {
    const result = checkTransition('DRIVER_ARRIVED', 'TRIP_STARTED', 'customer', ready);

    expect(result.allowed).toBe(false);
    expect(result.failure?.code).toBe('actor_not_permitted');
  });

  it('does not let a driver assign themselves work', () => {
    expect(checkTransition('FARE_LOCKED', 'DRIVER_ASSIGNED', 'driver', ready).allowed).toBe(false);
  });

  it('lets a driver declare a no-show but not cancel the trip outright', () => {
    expect(checkTransition('DRIVER_ARRIVED', 'NO_SHOW', 'driver', ready).allowed).toBe(true);
    expect(checkTransition('DRIVER_ARRIVED', 'CANCELLED', 'driver', ready).allowed).toBe(false);
  });
});

describe('preconditions', () => {
  it('refuses to lock a fare that was never agreed', () => {
    const result = checkTransition('FARE_ACCEPTED', 'FARE_LOCKED', 'system', { ...ready, hasFinalFare: false });

    expect(result.allowed).toBe(false);
    expect(result.failure?.code).toBe('precondition_failed');
  });

  it('refuses to assign a driver before the fare is locked', () => {
    const result = checkTransition('FARE_LOCKED', 'DRIVER_ASSIGNED', 'admin', { ...ready, fareLocked: false });

    expect(result.allowed).toBe(false);
    expect(result.failure?.code).toBe('precondition_failed');
  });

  it('refuses to mark a trip paid without verified payment', () => {
    const result = checkTransition('PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'system', {
      ...ready,
      paymentSettled: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.failure?.message).toMatch(/never marked paid on a client claim/);
  });
});

describe('admin force', () => {
  it('waives actor and precondition checks on a legal edge', () => {
    const result = checkTransition('FARE_LOCKED', 'DRIVER_ASSIGNED', 'admin', {
      ...ready,
      fareLocked: false,
      forced: true,
    });

    expect(result.allowed).toBe(true);
  });

  it('still refuses an edge that does not exist', () => {
    const result = checkTransition('REQUESTED', 'COMPLETED', 'admin', { ...ready, forced: true });

    expect(result.allowed).toBe(false);
    expect(result.failure?.code).toBe('illegal_transition');
  });
});

describe('graph integrity', () => {
  it('defines transitions for every status', () => {
    for (const status of TRIP_STATUSES) {
      expect(TRIP_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('only ever points at real statuses', () => {
    for (const rules of Object.values(TRIP_TRANSITIONS)) {
      for (const rule of rules) {
        expect(TRIP_STATUSES).toContain(rule.to);
        expect(rule.actors.length).toBeGreaterThan(0);
      }
    }
  });

  it('gives every terminal status no outbound edge except a dispute', () => {
    for (const status of TERMINAL_STATUSES) {
      const targets = allowedTransitions(status);
      expect(targets.every((target) => target === 'DISPUTED')).toBe(true);
    }
  });

  it('has a plain-language label for every status', () => {
    for (const status of TRIP_STATUSES) {
      expect(customerStatusLabel(status).length).toBeGreaterThan(0);
    }
  });
});
