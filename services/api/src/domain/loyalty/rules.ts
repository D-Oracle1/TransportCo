import type { LoyaltyPolicy, MinorUnits } from '@transportco/types';

/**
 * Loyalty rules.
 *
 * The default policy is 10 points per ₦1,000 spent, each point worth ₦1 — a 1%
 * effective return. Both halves are configuration, because the rate is a
 * commercial lever and hardcoding it would mean a deploy every time marketing
 * wants to move it.
 *
 * Points are earned on the FINAL fare actually paid, never on the quoted fare.
 * Rewarding a customer for a discount they negotiated would pay twice for the
 * same trip.
 */

export function computeEarnedPoints(paidAmountMinor: MinorUnits, policy: LoyaltyPolicy): number {
  if (!policy.enabled) return 0;
  if (paidAmountMinor <= 0) return 0;
  if (policy.pointsPerSpendUnitMinor <= 0) return 0;

  // Whole units only: ₦1,500 earns one unit's worth, not one and a half. Simple
  // to explain, and it never rounds in the customer's disfavour by surprise.
  const units = Math.floor(paidAmountMinor / policy.pointsPerSpendUnitMinor);
  return Math.floor(units * policy.pointsPerUnit);
}

export interface RedemptionQuote {
  /** Points that will actually be burned. */
  points: number;
  /** Discount those points buy, in minor units. */
  valueMinor: MinorUnits;
  /** What the customer still pays. */
  payableMinor: MinorUnits;
  /** Why the request was trimmed, when it was. */
  cappedBy: 'none' | 'balance' | 'fare_percentage' | 'minimum_points' | 'disabled';
}

/**
 * Work out what a redemption request actually yields.
 *
 * Every cap is applied server-side. A client asking to burn 50,000 points on a
 * ₦2,000 fare gets a correct, bounded answer rather than a free ride.
 */
export function quoteRedemption(args: {
  requestedPoints: number;
  balancePoints: number;
  fareMinor: MinorUnits;
  policy: LoyaltyPolicy;
}): RedemptionQuote {
  const { policy, fareMinor } = args;
  const none: RedemptionQuote = {
    points: 0,
    valueMinor: 0,
    payableMinor: fareMinor,
    cappedBy: 'none',
  };

  if (!policy.enabled || policy.pointValueMinor <= 0) {
    return { ...none, cappedBy: 'disabled' };
  }

  const requested = Math.max(0, Math.floor(args.requestedPoints));
  if (requested === 0) return none;

  if (requested < policy.minimumRedeemablePoints) {
    return { ...none, cappedBy: 'minimum_points' };
  }

  let points = Math.min(requested, Math.max(0, args.balancePoints));
  let cappedBy: RedemptionQuote['cappedBy'] = points < requested ? 'balance' : 'none';

  // Loyalty may only ever discount part of a fare — a trip must still generate
  // cash to cover the driver and the fuel.
  const maxDiscountMinor = Math.floor((fareMinor * policy.maxRedemptionPercentOfFare) / 100);
  let valueMinor = points * policy.pointValueMinor;

  if (valueMinor > maxDiscountMinor) {
    valueMinor = maxDiscountMinor;
    points = Math.floor(valueMinor / policy.pointValueMinor);
    valueMinor = points * policy.pointValueMinor;
    cappedBy = 'fare_percentage';
  }

  if (points < policy.minimumRedeemablePoints) {
    return { ...none, cappedBy: 'minimum_points' };
  }

  return {
    points,
    valueMinor,
    payableMinor: Math.max(0, fareMinor - valueMinor),
    cappedBy,
  };
}

/** Expiry date for points earned now, or null when they never expire. */
export function pointsExpiryDate(earnedAt: Date, policy: LoyaltyPolicy): Date | null {
  if (policy.pointsExpiryDays == null) return null;
  return new Date(earnedAt.getTime() + policy.pointsExpiryDays * 24 * 60 * 60 * 1000);
}

/** Tier from lifetime spend. Cosmetic in Phase 1; the ladder exists for Phase 2. */
export function tierForLifetimePoints(lifetimeEarnedPoints: number): 'standard' | 'silver' | 'gold' | 'platinum' {
  if (lifetimeEarnedPoints >= 20_000) return 'platinum';
  if (lifetimeEarnedPoints >= 8_000) return 'gold';
  if (lifetimeEarnedPoints >= 2_000) return 'silver';
  return 'standard';
}
