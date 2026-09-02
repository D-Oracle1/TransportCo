import type {
  FareBreakdown,
  FareCalculationInput,
  FareComponent,
  MinorUnits,
  MultiplierRule,
  PricingRuleSet,
} from '@transportco/types';
import {
  clampMinor,
  isMinuteInWindow,
  localParts,
  multiplyMinor,
  roundUpToIncrement,
  sumMinor,
} from '@transportco/utils';

/**
 * THE PRICING ENGINE.
 *
 * Pure and deterministic: the same inputs and the same rule set always produce
 * the same fare, with no clock, no database and no network inside. That is what
 * makes a completed trip re-derivable years later, and what makes this file
 * cheap to test exhaustively.
 *
 * The authoritative fare is produced HERE, on the server, and nowhere else. The
 * mobile apps render what the API returns; they never compute a price.
 *
 * Order of operations (deliberate, and the reason it is written down):
 *   1. Additive components — base, distance, duration, extra passengers.
 *   2. Multiplicative adjustments applied to that subtotal, each recorded as
 *      the DELTA it contributed, so the breakdown always sums to the total.
 *   3. Minimum fare floor, then maximum fare ceiling.
 *   4. Round up to a clean increment.
 *
 * Multipliers compose additively rather than by multiplication: a peak (+20%)
 * night (+15%) trip is +35%, not +38%. Compounding surcharges is how a fare
 * quietly becomes indefensible, and a customer who feels ambushed by a price
 * does not come back.
 */

const KM = 1000;
const MINUTE = 60;

/** True when `at` falls inside any of the rule's windows, in LOCAL time. */
export function isRuleActive(
  rule: MultiplierRule,
  at: Date,
  timezoneOffsetMinutes: number,
  publicHolidayDates: string[] = [],
): boolean {
  if (!rule.enabled || rule.windows.length === 0) return false;

  const { weekday, minuteOfDay, isoDate } = localParts(at, timezoneOffsetMinutes);

  // The public-holiday rule is date-driven rather than window-driven.
  if (rule.code === 'public_holiday' && !publicHolidayDates.includes(isoDate)) return false;

  return rule.windows.some((window) => {
    if (window.weekdays && window.weekdays.length > 0 && !window.weekdays.includes(weekday as never)) {
      return false;
    }
    // A full-day window is expressed as 0..1440 and needs no minute check.
    if (window.startMinute === 0 && window.endMinute >= 24 * 60) return true;
    return isMinuteInWindow(minuteOfDay, window.startMinute, window.endMinute);
  });
}

function distanceCharge(
  rules: PricingRuleSet,
  distanceMetres: number,
): { standard: MinorUnits; longDistance: MinorUnits } {
  const threshold = rules.longDistanceThresholdMetres;
  const chargeableStandard =
    threshold > 0 ? Math.min(distanceMetres, threshold) : distanceMetres;
  const chargeableLong = threshold > 0 ? Math.max(0, distanceMetres - threshold) : 0;

  return {
    standard: Math.round((chargeableStandard / KM) * rules.perKilometreMinor),
    longDistance: Math.round((chargeableLong / KM) * rules.longDistancePerKilometreMinor),
  };
}

export interface FareCalculationResult extends FareBreakdown {
  /** Convenience aliases used by callers that only care about the headline. */
  quotedFareMinor: MinorUnits;
}

export function calculateFare(rules: PricingRuleSet, input: FareCalculationInput): FareCalculationResult {
  if (!Number.isFinite(input.distanceMetres) || input.distanceMetres < 0) {
    throw new RangeError('distanceMetres must be a non-negative number');
  }
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 0) {
    throw new RangeError('durationSeconds must be a non-negative number');
  }
  if (input.passengers < 1) {
    throw new RangeError('passengers must be at least 1');
  }
  if (input.passengers > rules.maxPassengers) {
    throw new RangeError(`passengers exceeds the configured maximum of ${rules.maxPassengers}`);
  }

  const components: FareComponent[] = [];

  // --- 1. Additive components ------------------------------------------------
  components.push({ code: 'base_fare', label: 'Base fare', amountMinor: rules.baseFareMinor });

  const distance = distanceCharge(rules, input.distanceMetres);
  components.push({ code: 'distance', label: 'Distance', amountMinor: distance.standard });
  if (distance.longDistance > 0) {
    components.push({
      code: 'long_distance',
      label: 'Long distance',
      amountMinor: distance.longDistance,
    });
  }

  components.push({
    code: 'duration',
    label: 'Time',
    amountMinor: Math.round((input.durationSeconds / MINUTE) * rules.perMinuteMinor),
  });

  const extraPassengers = Math.max(0, input.passengers - rules.includedPassengers);
  if (extraPassengers > 0 && rules.extraPassengerFeeMinor > 0) {
    components.push({
      code: 'extra_passengers',
      label: `Extra passengers (${extraPassengers})`,
      amountMinor: extraPassengers * rules.extraPassengerFeeMinor,
    });
  }

  const additiveSubtotal = sumMinor(components.map((component) => component.amountMinor));

  // --- 2. Multiplicative adjustments ----------------------------------------
  // Each active rule contributes (multiplier - 1) of the additive subtotal.
  // Summing the surcharges keeps the total defensible on a receipt.
  const surcharges: Array<{ code: FareComponent['code']; label: string; multiplier: number }> = [];

  if (isRuleActive(rules.peak, input.rideAt, input.timezoneOffsetMinutes)) {
    surcharges.push({ code: 'peak', label: rules.peak.label, multiplier: rules.peak.multiplier });
  }
  if (isRuleActive(rules.night, input.rideAt, input.timezoneOffsetMinutes)) {
    surcharges.push({ code: 'night', label: rules.night.label, multiplier: rules.night.multiplier });
  }
  if (isRuleActive(rules.weekend, input.rideAt, input.timezoneOffsetMinutes)) {
    surcharges.push({ code: 'weekend', label: rules.weekend.label, multiplier: rules.weekend.multiplier });
  }
  if (isRuleActive(rules.publicHoliday, input.rideAt, input.timezoneOffsetMinutes, rules.publicHolidayDates)) {
    surcharges.push({
      code: 'public_holiday',
      label: rules.publicHoliday.label,
      multiplier: rules.publicHoliday.multiplier,
    });
  }
  if (rules.demandMultiplier > 1) {
    // Operations can raise demand pricing, but never past the configured ceiling.
    const capped = Math.min(rules.demandMultiplier, rules.demandMultiplierMax);
    surcharges.push({ code: 'demand', label: 'High demand', multiplier: capped });
  }
  if (input.isScheduled && rules.scheduledRideMultiplier !== 1) {
    surcharges.push({
      code: 'scheduled',
      label: 'Scheduled ride',
      multiplier: rules.scheduledRideMultiplier,
    });
  }

  for (const surcharge of surcharges) {
    const delta = multiplyMinor(additiveSubtotal, surcharge.multiplier - 1);
    if (delta === 0) continue;
    components.push({
      code: surcharge.code,
      label: surcharge.label,
      amountMinor: delta,
      multiplier: surcharge.multiplier,
    });
  }

  const subtotalMinor = sumMinor(components.map((component) => component.amountMinor));

  // --- 3. Floor and ceiling --------------------------------------------------
  let totalMinor = subtotalMinor;

  if (totalMinor < rules.minimumFareMinor) {
    const adjustment = rules.minimumFareMinor - totalMinor;
    components.push({
      code: 'minimum_fare_adjustment',
      label: 'Minimum fare',
      amountMinor: adjustment,
    });
    totalMinor = rules.minimumFareMinor;
  }

  if (rules.maximumFareMinor !== null && totalMinor > rules.maximumFareMinor) {
    const adjustment = rules.maximumFareMinor - totalMinor;
    components.push({
      code: 'maximum_fare_adjustment',
      label: 'Maximum fare cap',
      amountMinor: adjustment,
    });
    totalMinor = rules.maximumFareMinor;
  }

  // --- 4. Rounding -----------------------------------------------------------
  if (rules.roundToNearestMinor > 0) {
    const rounded = roundUpToIncrement(totalMinor, rules.roundToNearestMinor);
    if (rounded !== totalMinor) {
      components.push({ code: 'rounding', label: 'Rounding', amountMinor: rounded - totalMinor });
      totalMinor = rounded;
    }
  }

  totalMinor = clampMinor(totalMinor, rules.minimumFareMinor, rules.maximumFareMinor);

  const { floorMinor, autoAcceptAtOrAboveMinor } = negotiationBounds(rules, totalMinor);

  return {
    currency: rules.currency,
    components,
    subtotalMinor,
    totalMinor,
    floorMinor,
    autoAcceptAtOrAboveMinor,
    distanceMetres: Math.round(input.distanceMetres),
    durationSeconds: Math.round(input.durationSeconds),
    pricingRuleSetId: rules.id,
    pricingVersion: rules.version,
    quotedFareMinor: totalMinor,
  };
}

/**
 * The two thresholds that drive negotiation, derived from the quoted fare.
 *
 * Both are INTERNAL. Neither is ever serialised to a customer — knowing the
 * floor turns every negotiation into a one-move game.
 *
 * The floor additionally never dips below the minimum fare: a discount that
 * takes a trip below the price at which it is worth dispatching a company
 * vehicle is not a discount, it is a loss.
 */
export function negotiationBounds(
  rules: PricingRuleSet,
  quotedFareMinor: MinorUnits,
): { floorMinor: MinorUnits; autoAcceptAtOrAboveMinor: MinorUnits } {
  const { negotiation } = rules;

  if (!negotiation.enabled) {
    return { floorMinor: quotedFareMinor, autoAcceptAtOrAboveMinor: quotedFareMinor };
  }

  const rawFloor = multiplyMinor(quotedFareMinor, 1 - negotiation.maxDiscountPercent / 100);
  const floorMinor = Math.max(rawFloor, Math.min(rules.minimumFareMinor, quotedFareMinor));

  const rawAutoAccept = multiplyMinor(quotedFareMinor, 1 - negotiation.autoAcceptDiscountPercent / 100);
  const autoAcceptAtOrAboveMinor = Math.max(rawAutoAccept, floorMinor);

  return { floorMinor, autoAcceptAtOrAboveMinor };
}

/**
 * Cancellation fee for a trip in a given state. Configuration-driven — the
 * amounts and windows are pricing data, not constants in a screen.
 */
export function cancellationFee(
  rules: PricingRuleSet,
  args: {
    status: string;
    fareLockedAt: Date | null;
    scheduledPickupAt: Date | null;
    now: Date;
  },
): { feeMinor: MinorUnits; reasonCode: string } {
  const policy = rules.cancellation;

  // Everyone gets a grace period after locking the fare — a misfired tap is
  // not a chargeable event.
  if (args.fareLockedAt) {
    const elapsedSeconds = (args.now.getTime() - args.fareLockedAt.getTime()) / 1000;
    if (elapsedSeconds <= policy.gracePeriodSeconds) {
      return { feeMinor: 0, reasonCode: 'within_grace_period' };
    }
  }

  switch (args.status) {
    case 'REQUESTED':
    case 'FARE_CALCULATED':
    case 'NEGOTIATING':
    case 'FARE_ACCEPTED':
      return { feeMinor: 0, reasonCode: 'before_assignment' };

    case 'FARE_LOCKED': {
      // A scheduled ride cancelled close to pickup has already cost us a
      // committed driver slot.
      if (args.scheduledPickupAt) {
        const secondsToPickup = (args.scheduledPickupAt.getTime() - args.now.getTime()) / 1000;
        if (secondsToPickup <= policy.scheduledLateCancelWindowSeconds) {
          return { feeMinor: policy.afterAssignmentFeeMinor, reasonCode: 'scheduled_late_cancel' };
        }
      }
      return { feeMinor: 0, reasonCode: 'before_assignment' };
    }

    case 'DRIVER_ASSIGNED':
      return { feeMinor: policy.afterAssignmentFeeMinor, reasonCode: 'after_assignment' };

    case 'DRIVER_EN_ROUTE':
      return { feeMinor: policy.driverEnRouteFeeMinor, reasonCode: 'driver_en_route' };

    case 'DRIVER_ARRIVED':
      return { feeMinor: policy.driverArrivedFeeMinor, reasonCode: 'driver_arrived' };

    case 'NO_SHOW':
      return { feeMinor: policy.noShowFeeMinor, reasonCode: 'no_show' };

    default:
      // A trip already under way cannot be "cancelled" — it is completed or
      // disputed. Callers must not reach here; return no fee rather than guess.
      return { feeMinor: 0, reasonCode: 'not_cancellable' };
  }
}

/**
 * Unit economics for one trip. Feeds the contribution-margin reporting that
 * tells management whether negotiating is winning volume or just giving away
 * money.
 */
export function contributionMargin(
  rules: PricingRuleSet,
  args: {
    finalFareMinor: MinorUnits;
    quotedFareMinor: MinorUnits;
    distanceMetres: number;
    refundedMinor?: MinorUnits;
    paidByCard: boolean;
  },
): {
  revenueMinor: MinorUnits;
  discountMinor: MinorUnits;
  energyCostMinor: MinorUnits;
  driverVariableCostMinor: MinorUnits;
  operationalCostMinor: MinorUnits;
  paymentFeeMinor: MinorUnits;
  refundMinor: MinorUnits;
  contributionMarginMinor: MinorUnits;
  marginPercent: number;
} {
  const cost = rules.costModel;
  const refundMinor = args.refundedMinor ?? 0;
  const revenueMinor = args.finalFareMinor - refundMinor;
  const discountMinor = Math.max(0, args.quotedFareMinor - args.finalFareMinor);

  const energyCostMinor = Math.round((args.distanceMetres / KM) * cost.fuelOrEnergyCostPerKmMinor);

  let paymentFeeMinor = 0;
  if (args.paidByCard) {
    const percentFee = Math.round((args.finalFareMinor * cost.paymentFeePercent) / 100);
    paymentFeeMinor = percentFee + cost.paymentFeeFlatMinor;
    if (cost.paymentFeeCapMinor !== null) {
      paymentFeeMinor = Math.min(paymentFeeMinor, cost.paymentFeeCapMinor);
    }
  }

  const contributionMarginMinor =
    revenueMinor -
    energyCostMinor -
    cost.driverVariableCostPerTripMinor -
    cost.operationalOverheadPerTripMinor -
    paymentFeeMinor;

  return {
    revenueMinor,
    discountMinor,
    energyCostMinor,
    driverVariableCostMinor: cost.driverVariableCostPerTripMinor,
    operationalCostMinor: cost.operationalOverheadPerTripMinor,
    paymentFeeMinor,
    refundMinor,
    contributionMarginMinor,
    marginPercent:
      revenueMinor > 0 ? Math.round((contributionMarginMinor / revenueMinor) * 10_000) / 100 : 0,
  };
}
