import { describe, expect, it } from 'vitest';
import { computeEarnedPoints, pointsExpiryDate, quoteRedemption, tierForLifetimePoints } from './rules';
import { makePricingRuleSet } from '../testing/fixtures';

const policy = makePricingRuleSet().loyalty;

describe('computeEarnedPoints', () => {
  it('awards 10 points per ₦1,000 spent', () => {
    expect(computeEarnedPoints(100_000, policy)).toBe(10); // ₦1,000
    expect(computeEarnedPoints(740_000, policy)).toBe(70); // ₦7,400 -> 7 whole units
  });

  it('awards nothing below one whole unit', () => {
    expect(computeEarnedPoints(99_900, policy)).toBe(0);
  });

  it('awards nothing when loyalty is switched off', () => {
    expect(computeEarnedPoints(500_000, { ...policy, enabled: false })).toBe(0);
  });

  it('ignores zero and negative amounts', () => {
    expect(computeEarnedPoints(0, policy)).toBe(0);
    expect(computeEarnedPoints(-100, policy)).toBe(0);
  });
});

describe('quoteRedemption', () => {
  it('converts points to a discount at the configured rate', () => {
    const quote = quoteRedemption({
      requestedPoints: 1_000,
      balancePoints: 5_000,
      fareMinor: 740_000,
      policy,
    });

    expect(quote.points).toBe(1_000);
    expect(quote.valueMinor).toBe(100_000); // ₦1,000
    expect(quote.payableMinor).toBe(640_000);
  });

  it('never lets loyalty cover more than the configured share of a fare', () => {
    // A trip must still produce cash for the driver and the fuel.
    const quote = quoteRedemption({
      requestedPoints: 100_000,
      balancePoints: 100_000,
      fareMinor: 400_000,
      policy,
    });

    expect(quote.valueMinor).toBe(200_000); // 50% cap
    expect(quote.payableMinor).toBe(200_000);
    expect(quote.cappedBy).toBe('fare_percentage');
  });

  it('caps redemption at the customer balance', () => {
    const quote = quoteRedemption({
      requestedPoints: 5_000,
      balancePoints: 800,
      fareMinor: 740_000,
      policy,
    });

    expect(quote.points).toBe(800);
    expect(quote.cappedBy).toBe('balance');
  });

  it('refuses a redemption below the minimum', () => {
    const quote = quoteRedemption({
      requestedPoints: 100,
      balancePoints: 5_000,
      fareMinor: 740_000,
      policy,
    });

    expect(quote.points).toBe(0);
    expect(quote.cappedBy).toBe('minimum_points');
    expect(quote.payableMinor).toBe(740_000);
  });

  it('never returns a negative payable amount', () => {
    const quote = quoteRedemption({
      requestedPoints: 1_000_000,
      balancePoints: 1_000_000,
      fareMinor: 120_000,
      policy: { ...policy, maxRedemptionPercentOfFare: 100 },
    });

    expect(quote.payableMinor).toBeGreaterThanOrEqual(0);
    expect(quote.valueMinor).toBeLessThanOrEqual(120_000);
  });
});

describe('expiry and tiers', () => {
  it('dates expiry from the earn moment', () => {
    const earnedAt = new Date('2026-03-10T10:00:00.000Z');
    const expiry = pointsExpiryDate(earnedAt, policy);

    expect(expiry?.toISOString()).toBe('2027-03-10T10:00:00.000Z');
  });

  it('returns null when points never expire', () => {
    expect(pointsExpiryDate(new Date(), { ...policy, pointsExpiryDays: null })).toBeNull();
  });

  it('promotes through the tier ladder', () => {
    expect(tierForLifetimePoints(0)).toBe('standard');
    expect(tierForLifetimePoints(2_000)).toBe('silver');
    expect(tierForLifetimePoints(8_000)).toBe('gold');
    expect(tierForLifetimePoints(20_000)).toBe('platinum');
  });
});
