import { describe, expect, it } from 'vitest';
import type { NegotiationPolicy } from '@transportco/types';
import {
  computeAutoCounter,
  evaluateCustomerOffer,
  isOfferExpired,
  secondsRemaining,
  validateAdminCounter,
  type NegotiationState,
} from './engine';
import { makePricingRuleSet } from '../testing/fixtures';

const policy: NegotiationPolicy = makePricingRuleSet().negotiation;

/**
 * The worked example from the product brief:
 *   quote ₦8,000, floor ₦6,800 (15% off), auto-accept ₦7,600 (5% off).
 */
function state(overrides: Partial<NegotiationState> = {}): NegotiationState {
  return {
    status: 'OPEN',
    originalFareMinor: 800_000,
    floorMinor: 680_000,
    autoAcceptAtOrAboveMinor: 760_000,
    companyPositionMinor: 800_000,
    customerRoundsUsed: 0,
    maxCustomerRounds: 2,
    ...overrides,
  };
}

describe('evaluateCustomerOffer', () => {
  it('auto-accepts an offer inside the acceptance band', () => {
    const decision = evaluateCustomerOffer(state(), 770_000, policy);

    expect(decision.kind).toBe('ACCEPT');
    expect(decision.reasonCode).toBe('at_or_above_auto_accept');
  });

  it('auto-rejects an offer below the floor', () => {
    const decision = evaluateCustomerOffer(state(), 500_000, policy);

    expect(decision.kind).toBe('REJECT');
    expect(decision.reasonCode).toBe('below_floor');
  });

  it('sends an offer in the review band to a human', () => {
    const decision = evaluateCustomerOffer(state(), 700_000, policy);

    expect(decision.kind).toBe('REVIEW');
    expect(decision.reasonCode).toBe('within_review_band');
  });

  it('auto-counters when admin review is switched off', () => {
    const unattended: NegotiationPolicy = { ...policy, adminReviewEnabled: false };
    const decision = evaluateCustomerOffer(state(), 700_000, unattended);

    expect(decision.kind).toBe('COUNTER');
    expect(decision.counterAmountMinor).toBeGreaterThan(700_000);
    expect(decision.counterAmountMinor).toBeLessThan(800_000);
  });

  it('accepts an offer that meets the company position however low that position is', () => {
    const decision = evaluateCustomerOffer(
      state({ companyPositionMinor: 740_000, customerRoundsUsed: 1 }),
      740_000,
      policy,
    );

    expect(decision.kind).toBe('ACCEPT');
    expect(decision.reasonCode).toBe('at_or_above_company_position');
  });

  it('lets a customer who has used every round still accept the company price', () => {
    // This ordering matters: checking the round limit first would trap a
    // customer who is trying to say yes.
    const decision = evaluateCustomerOffer(
      state({ customerRoundsUsed: 2, companyPositionMinor: 740_000 }),
      740_000,
      policy,
    );

    expect(decision.kind).toBe('ACCEPT');
  });

  it('blocks a third customer offer', () => {
    const decision = evaluateCustomerOffer(
      state({ customerRoundsUsed: 2, companyPositionMinor: 740_000 }),
      720_000,
      policy,
    );

    expect(decision.kind).toBe('LIMIT_REACHED');
    expect(decision.reasonCode).toBe('round_limit_reached');
  });

  it('rejects a closed negotiation', () => {
    expect(evaluateCustomerOffer(state({ status: 'ACCEPTED' }), 750_000, policy).kind).toBe('INVALID');
    expect(evaluateCustomerOffer(state({ status: 'EXPIRED' }), 750_000, policy).reasonCode).toBe(
      'negotiation_closed',
    );
  });

  it('treats an offer above the quote as an input error', () => {
    const decision = evaluateCustomerOffer(state(), 8_000_000, policy);

    expect(decision.kind).toBe('INVALID');
    expect(decision.reasonCode).toBe('offer_above_quote');
  });

  it('rejects non-positive and non-integer amounts', () => {
    expect(evaluateCustomerOffer(state(), 0, policy).kind).toBe('INVALID');
    expect(evaluateCustomerOffer(state(), -100, policy).kind).toBe('INVALID');
    expect(evaluateCustomerOffer(state(), 700_000.5, policy).reasonCode).toBe('offer_not_positive');
  });

  it('refuses to negotiate when the policy is disabled', () => {
    const decision = evaluateCustomerOffer(state(), 700_000, { ...policy, enabled: false });

    expect(decision.reasonCode).toBe('negotiation_disabled');
  });

  // The single most important security property of this module.
  it('never reveals the floor or the acceptance threshold to the customer', () => {
    const secrets = ['680', '6,800', '760', '7,600'];
    const offers = [400_000, 500_000, 690_000, 700_000, 750_000, 799_000];

    for (const offer of offers) {
      const decision = evaluateCustomerOffer(state(), offer, policy);
      for (const secret of secrets) {
        expect(decision.customerMessage).not.toContain(secret);
      }
    }
  });
});

describe('computeAutoCounter', () => {
  it('meets the customer half way and rounds to a clean figure', () => {
    // ₦8,000 vs ₦7,000 at a 0.5 meet ratio => ₦7,500.
    const counter = computeAutoCounter(state(), 700_000, policy);

    expect(counter).toBe(750_000);
  });

  it('never counters below the floor', () => {
    const counter = computeAutoCounter(
      state({ companyPositionMinor: 700_000 }),
      600_000,
      { ...policy, autoCounterMeetRatio: 1 },
    );

    expect(counter).toBeGreaterThanOrEqual(680_000);
  });

  it('returns null when a counter would not sit between the two positions', () => {
    expect(computeAutoCounter(state({ companyPositionMinor: 700_000 }), 700_000, policy)).toBeNull();
    expect(computeAutoCounter(state(), 700_000, { ...policy, autoCounterMeetRatio: 0 })).toBeNull();
  });
});

describe('validateAdminCounter', () => {
  it('accepts a counter between the floor and the company position', () => {
    const result = validateAdminCounter(state(), 740_000, { overrideFloor: false });

    expect(result.valid).toBe(true);
    expect(result.requiresAudit).toBe(false);
  });

  it('refuses a counter that raises the price', () => {
    const result = validateAdminCounter(state({ companyPositionMinor: 750_000 }), 780_000, {
      overrideFloor: false,
    });

    expect(result.valid).toBe(false);
    expect(result.problem).toBe('above_company_position');
  });

  it('refuses a below-floor counter without an explicit override', () => {
    const result = validateAdminCounter(state(), 600_000, { overrideFloor: false });

    expect(result.valid).toBe(false);
    expect(result.problem).toBe('below_floor_without_override');
  });

  it('allows a below-floor counter with an override and flags it for audit', () => {
    const result = validateAdminCounter(state(), 600_000, { overrideFloor: true });

    expect(result.valid).toBe(true);
    expect(result.requiresAudit).toBe(true);
  });

  it('still refuses an override that breaches the absolute minimum', () => {
    const result = validateAdminCounter(state(), 50_000, {
      overrideFloor: true,
      absoluteMinimumMinor: 120_000,
    });

    expect(result.valid).toBe(false);
    expect(result.problem).toBe('below_minimum_possible');
  });
});

describe('offer expiry', () => {
  const now = new Date('2026-03-10T10:00:00.000Z');

  it('treats the expiry instant as expired', () => {
    expect(isOfferExpired(now, now)).toBe(true);
  });

  it('counts down and floors at zero', () => {
    expect(secondsRemaining(new Date(now.getTime() + 292_000), now)).toBe(292);
    expect(secondsRemaining(new Date(now.getTime() - 10_000), now)).toBe(0);
  });
});

describe('the brief\'s worked negotiation', () => {
  it('reaches ₦7,400 through the documented sequence', () => {
    // Company ₦8,000 -> customer ₦7,000 -> company ₦7,500 -> customer ₦7,300
    // -> company ₦7,400 -> customer accepts.
    let current = state();

    const first = evaluateCustomerOffer(current, 700_000, policy);
    expect(first.kind).toBe('REVIEW'); // a dispatcher is on the desk

    const firstCounter = validateAdminCounter(current, 750_000, { overrideFloor: false });
    expect(firstCounter.valid).toBe(true);
    current = { ...current, companyPositionMinor: 750_000, customerRoundsUsed: 1 };

    const second = evaluateCustomerOffer(current, 730_000, policy);
    expect(second.kind).toBe('REVIEW');

    const secondCounter = validateAdminCounter(current, 740_000, { overrideFloor: false });
    expect(secondCounter.valid).toBe(true);
    current = { ...current, companyPositionMinor: 740_000, customerRoundsUsed: 2 };

    // The customer accepts by meeting the company's position.
    const accepted = evaluateCustomerOffer(current, 740_000, policy);
    expect(accepted.kind).toBe('ACCEPT');
  });
});
