import type { CurrencyCode, MinorUnits } from '@transportco/types';

/**
 * Money helpers. Every amount in TransportCo is an integer in minor units
 * (kobo). These helpers are the ONLY place rounding happens, so a fare can
 * never gain or lose a kobo through incidental float arithmetic.
 */

export const MINOR_UNITS_PER_MAJOR = 100;

const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  NGN: '₦',
};

export function assertMinor(amount: number, label = 'amount'): MinorUnits {
  if (!Number.isFinite(amount)) throw new TypeError(`${label} must be a finite number`);
  if (!Number.isInteger(amount)) throw new TypeError(`${label} must be an integer in minor units`);
  return amount;
}

export function majorToMinor(major: number): MinorUnits {
  return Math.round(major * MINOR_UNITS_PER_MAJOR);
}

export function minorToMajor(minor: MinorUnits): number {
  return minor / MINOR_UNITS_PER_MAJOR;
}

/** Multiply money by a factor, rounding half-up to the nearest kobo. */
export function multiplyMinor(minor: MinorUnits, factor: number): MinorUnits {
  if (!Number.isFinite(factor)) throw new TypeError('factor must be finite');
  return Math.round(minor * factor);
}

/** Percentage of an amount, rounded half-up. `percent` is 1.5 for 1.5%. */
export function percentOfMinor(minor: MinorUnits, percent: number): MinorUnits {
  return Math.round((minor * percent) / 100);
}

/** Round UP to the nearest increment so displayed fares are clean numbers. */
export function roundUpToIncrement(minor: MinorUnits, incrementMinor: MinorUnits): MinorUnits {
  if (incrementMinor <= 0) return minor;
  return Math.ceil(minor / incrementMinor) * incrementMinor;
}

export function clampMinor(minor: MinorUnits, min: MinorUnits, max: MinorUnits | null): MinorUnits {
  const lower = Math.max(minor, min);
  return max === null ? lower : Math.min(lower, max);
}

export function sumMinor(amounts: MinorUnits[]): MinorUnits {
  return amounts.reduce((total, amount) => total + amount, 0);
}

/**
 * Discount of `offer` against `reference`, as a percentage with two decimals.
 * A higher number means a deeper discount.
 */
export function discountPercent(referenceMinor: MinorUnits, offerMinor: MinorUnits): number {
  if (referenceMinor <= 0) return 0;
  const raw = ((referenceMinor - offerMinor) / referenceMinor) * 100;
  return Math.round(raw * 100) / 100;
}

/** Format for display, e.g. 740000 -> "₦7,400". Never used for arithmetic. */
export function formatMoney(
  minor: MinorUnits,
  currency: CurrencyCode = 'NGN',
  options: { showDecimals?: boolean } = {},
): string {
  const showDecimals = options.showDecimals ?? minor % MINOR_UNITS_PER_MAJOR !== 0;
  const symbol = CURRENCY_SYMBOLS[currency] ?? '';
  const major = Math.abs(minor) / MINOR_UNITS_PER_MAJOR;
  const formatted = major.toLocaleString('en-NG', {
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  });
  return `${minor < 0 ? '-' : ''}${symbol}${formatted}`;
}
