import { describe, expect, it } from 'vitest';
import { sumMinor } from '@transportco/utils';
import {
  calculateFare,
  cancellationFee,
  contributionMargin,
  negotiationBounds,
} from './engine';
import {
  MORNING_PEAK_TUESDAY,
  NIGHT_TUESDAY,
  OFF_PEAK_TUESDAY,
  SATURDAY_MIDDAY,
  WAT_OFFSET_MINUTES,
  makePricingRuleSet,
} from '../testing/fixtures';

const baseInput = {
  distanceMetres: 12_000,
  durationSeconds: 25 * 60,
  passengers: 1,
  rideAt: OFF_PEAK_TUESDAY,
  isScheduled: false,
  timezoneOffsetMinutes: WAT_OFFSET_MINUTES,
};

describe('calculateFare', () => {
  it('adds base, distance and duration charges', () => {
    const rules = makePricingRuleSet();
    const fare = calculateFare(rules, baseInput);

    // ₦700 base + 12 km x ₦180 + 25 min x ₦25 = ₦700 + ₦2,160 + ₦625 = ₦3,485
    // then rounded up to the ₦50 increment => ₦3,500.
    expect(fare.subtotalMinor).toBe(348_500);
    expect(fare.totalMinor).toBe(350_000);
  });

  it('produces a breakdown whose components sum to the total', () => {
    const rules = makePricingRuleSet();
    const fare = calculateFare(rules, { ...baseInput, rideAt: MORNING_PEAK_TUESDAY });

    expect(sumMinor(fare.components.map((component) => component.amountMinor))).toBe(fare.totalMinor);
  });

  it('applies the minimum fare to very short trips', () => {
    const rules = makePricingRuleSet();
    const fare = calculateFare(rules, { ...baseInput, distanceMetres: 400, durationSeconds: 180 });

    expect(fare.totalMinor).toBe(rules.minimumFareMinor);
    expect(fare.components.some((component) => component.code === 'minimum_fare_adjustment')).toBe(true);
  });

  it('applies the maximum fare cap when configured', () => {
    const rules = makePricingRuleSet({ maximumFareMinor: 200_000 });
    const fare = calculateFare(rules, baseInput);

    expect(fare.totalMinor).toBe(200_000);
    expect(fare.components.some((component) => component.code === 'maximum_fare_adjustment')).toBe(true);
  });

  it('charges the peak surcharge inside the morning window only', () => {
    const rules = makePricingRuleSet();
    const offPeak = calculateFare(rules, baseInput);
    const peak = calculateFare(rules, { ...baseInput, rideAt: MORNING_PEAK_TUESDAY });

    expect(peak.totalMinor).toBeGreaterThan(offPeak.totalMinor);
    expect(peak.components.find((component) => component.code === 'peak')?.multiplier).toBe(1.2);
    expect(offPeak.components.some((component) => component.code === 'peak')).toBe(false);
  });

  it('charges the night surcharge for a window that wraps midnight', () => {
    const rules = makePricingRuleSet();
    const fare = calculateFare(rules, { ...baseInput, rideAt: NIGHT_TUESDAY });

    expect(fare.components.some((component) => component.code === 'night')).toBe(true);
  });

  it('charges the weekend surcharge on Saturday', () => {
    const rules = makePricingRuleSet();
    const fare = calculateFare(rules, { ...baseInput, rideAt: SATURDAY_MIDDAY });

    expect(fare.components.some((component) => component.code === 'weekend')).toBe(true);
  });

  it('composes surcharges additively rather than by compounding', () => {
    // A Saturday night trip is +15% night and +10% weekend => +25% of the
    // additive subtotal, NOT 1.15 x 1.10 = +26.5%.
    const rules = makePricingRuleSet();
    const saturdayNight = new Date('2026-03-14T22:00:00.000Z'); // Sat 23:00 local
    const fare = calculateFare(rules, { ...baseInput, rideAt: saturdayNight });

    const additive = fare.components
      .filter((component) => ['base_fare', 'distance', 'duration'].includes(component.code))
      .reduce((total, component) => total + component.amountMinor, 0);

    const surcharges = fare.components
      .filter((component) => ['night', 'weekend'].includes(component.code))
      .reduce((total, component) => total + component.amountMinor, 0);

    expect(surcharges).toBe(Math.round(additive * 0.15) + Math.round(additive * 0.1));
  });

  it('charges the long-distance rate beyond the threshold', () => {
    const rules = makePricingRuleSet();
    const fare = calculateFare(rules, { ...baseInput, distanceMetres: 45_000 });

    const standard = fare.components.find((component) => component.code === 'distance');
    const long = fare.components.find((component) => component.code === 'long_distance');

    // First 30 km at ₦180, the remaining 15 km at ₦140.
    expect(standard?.amountMinor).toBe(30 * 18_000);
    expect(long?.amountMinor).toBe(15 * 14_000);
  });

  it('charges for passengers beyond the included allowance', () => {
    const rules = makePricingRuleSet();
    const solo = calculateFare(rules, baseInput);
    const crowded = calculateFare(rules, { ...baseInput, passengers: 5 });

    expect(crowded.totalMinor).toBeGreaterThan(solo.totalMinor);
    expect(crowded.components.find((component) => component.code === 'extra_passengers')?.amountMinor).toBe(
      2 * rules.extraPassengerFeeMinor,
    );
  });

  it('adds the scheduled-ride adjustment only for scheduled trips', () => {
    const rules = makePricingRuleSet();
    const immediate = calculateFare(rules, baseInput);
    const scheduled = calculateFare(rules, { ...baseInput, isScheduled: true });

    expect(scheduled.totalMinor).toBeGreaterThan(immediate.totalMinor);
  });

  it('caps the demand multiplier at its configured ceiling', () => {
    // Someone types 5.0 into the demand dial. The engine must clamp to 1.8.
    const clamped = makePricingRuleSet({ demandMultiplier: 5, demandMultiplierMax: 1.8 });
    const atCeiling = makePricingRuleSet({ demandMultiplier: 1.8, demandMultiplierMax: 1.8 });

    expect(calculateFare(clamped, baseInput).totalMinor).toBe(calculateFare(atCeiling, baseInput).totalMinor);
  });

  it('is deterministic for identical inputs', () => {
    const rules = makePricingRuleSet();
    expect(calculateFare(rules, baseInput)).toEqual(calculateFare(rules, baseInput));
  });

  it('returns whole kobo, never fractions', () => {
    const rules = makePricingRuleSet();
    const fare = calculateFare(rules, { ...baseInput, distanceMetres: 7_777, durationSeconds: 1_333 });

    expect(Number.isInteger(fare.totalMinor)).toBe(true);
    for (const component of fare.components) {
      expect(Number.isInteger(component.amountMinor)).toBe(true);
    }
  });

  it('rejects impossible inputs rather than inventing a fare', () => {
    const rules = makePricingRuleSet();

    expect(() => calculateFare(rules, { ...baseInput, distanceMetres: -1 })).toThrow(RangeError);
    expect(() => calculateFare(rules, { ...baseInput, passengers: 0 })).toThrow(RangeError);
    expect(() => calculateFare(rules, { ...baseInput, passengers: 99 })).toThrow(RangeError);
  });
});

describe('negotiationBounds', () => {
  it('derives the floor and auto-accept threshold from the quote', () => {
    const rules = makePricingRuleSet();
    const bounds = negotiationBounds(rules, 800_000); // ₦8,000

    expect(bounds.floorMinor).toBe(680_000); // 15% off
    expect(bounds.autoAcceptAtOrAboveMinor).toBe(760_000); // 5% off
  });

  it('never lets the floor fall below the minimum fare', () => {
    const rules = makePricingRuleSet({ minimumFareMinor: 120_000, negotiation: { ...makePricingRuleSet().negotiation, maxDiscountPercent: 50 } });
    const bounds = negotiationBounds(rules, 130_000);

    expect(bounds.floorMinor).toBe(120_000);
  });

  it('collapses both bounds onto the quote when negotiation is disabled', () => {
    const rules = makePricingRuleSet({
      negotiation: { ...makePricingRuleSet().negotiation, enabled: false },
    });
    const bounds = negotiationBounds(rules, 800_000);

    expect(bounds.floorMinor).toBe(800_000);
    expect(bounds.autoAcceptAtOrAboveMinor).toBe(800_000);
  });
});

describe('cancellationFee', () => {
  const rules = makePricingRuleSet();
  const now = new Date('2026-03-10T10:00:00.000Z');

  it('charges nothing inside the grace period', () => {
    const result = cancellationFee(rules, {
      status: 'DRIVER_ASSIGNED',
      fareLockedAt: new Date(now.getTime() - 30_000),
      scheduledPickupAt: null,
      now,
    });

    expect(result.feeMinor).toBe(0);
    expect(result.reasonCode).toBe('within_grace_period');
  });

  it('charges nothing before a driver is assigned', () => {
    expect(
      cancellationFee(rules, { status: 'FARE_LOCKED', fareLockedAt: null, scheduledPickupAt: null, now }).feeMinor,
    ).toBe(0);
  });

  it('escalates the fee as the driver gets closer', () => {
    const assigned = cancellationFee(rules, { status: 'DRIVER_ASSIGNED', fareLockedAt: null, scheduledPickupAt: null, now });
    const enRoute = cancellationFee(rules, { status: 'DRIVER_EN_ROUTE', fareLockedAt: null, scheduledPickupAt: null, now });
    const arrived = cancellationFee(rules, { status: 'DRIVER_ARRIVED', fareLockedAt: null, scheduledPickupAt: null, now });

    expect(assigned.feeMinor).toBeLessThan(enRoute.feeMinor);
    expect(enRoute.feeMinor).toBeLessThan(arrived.feeMinor);
  });

  it('charges a late-cancellation fee on scheduled rides close to pickup', () => {
    const result = cancellationFee(rules, {
      status: 'FARE_LOCKED',
      fareLockedAt: null,
      scheduledPickupAt: new Date(now.getTime() + 20 * 60_000),
      now,
    });

    expect(result.feeMinor).toBe(rules.cancellation.afterAssignmentFeeMinor);
    expect(result.reasonCode).toBe('scheduled_late_cancel');
  });
});

describe('contributionMargin', () => {
  it('accounts for the discount given away during negotiation', () => {
    const rules = makePricingRuleSet();
    const margin = contributionMargin(rules, {
      quotedFareMinor: 800_000,
      finalFareMinor: 740_000,
      distanceMetres: 12_000,
      paidByCard: false,
    });

    expect(margin.discountMinor).toBe(60_000);
    expect(margin.paymentFeeMinor).toBe(0); // cash carries no provider fee
    // ₦7,400 − ₦1,080 fuel − ₦150 driver − ₦200 ops = ₦5,970
    expect(margin.contributionMarginMinor).toBe(597_000);
  });

  it('charges percentage plus flat provider fee on card payments', () => {
    const rules = makePricingRuleSet();
    const margin = contributionMargin(rules, {
      quotedFareMinor: 800_000,
      finalFareMinor: 800_000,
      distanceMetres: 12_000,
      paidByCard: true,
    });

    // 1.5% of ₦8,000 = ₦120, plus the ₦100 flat fee.
    expect(margin.paymentFeeMinor).toBe(12_000 + rules.costModel.paymentFeeFlatMinor);
  });

  it('caps the provider fee on a large intercity charter', () => {
    // ₦150,000 charter: 1.5% is ₦2,250, above the ₦2,000 cap the local
    // providers apply. Without the cap we would over-state our own costs.
    const rules = makePricingRuleSet();
    const margin = contributionMargin(rules, {
      quotedFareMinor: 15_000_000,
      finalFareMinor: 15_000_000,
      distanceMetres: 400_000,
      paidByCard: true,
    });

    expect(margin.paymentFeeMinor).toBe(rules.costModel.paymentFeeCapMinor);
  });
});
