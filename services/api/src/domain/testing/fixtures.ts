import { DEFAULT_PRICING_RULE_SET } from '@transportco/config';
import type { PricingRuleSet } from '@transportco/types';

/**
 * Test fixtures. Built from the real seeded defaults rather than from invented
 * numbers, so a test failing after someone edits the launch pricing is a signal
 * worth reading, not noise to be silenced.
 */
export function makePricingRuleSet(overrides: Partial<PricingRuleSet> = {}): PricingRuleSet {
  return {
    ...DEFAULT_PRICING_RULE_SET,
    id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    status: 'published',
    zoneId: null,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    createdByUserId: null,
    publishedByUserId: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A weekday mid-morning in West Africa Time — outside every surcharge window.
 * Tuesday 2026-03-10, 10:00 local (09:00 UTC).
 */
export const OFF_PEAK_TUESDAY = new Date('2026-03-10T09:00:00.000Z');

/** Tuesday 2026-03-10, 08:00 local (07:00 UTC) — inside the morning peak. */
export const MORNING_PEAK_TUESDAY = new Date('2026-03-10T07:00:00.000Z');

/** Tuesday 2026-03-10, 23:00 local (22:00 UTC) — inside the night window. */
export const NIGHT_TUESDAY = new Date('2026-03-10T22:00:00.000Z');

/** Saturday 2026-03-14, 12:00 local (11:00 UTC). */
export const SATURDAY_MIDDAY = new Date('2026-03-14T11:00:00.000Z');

export const WAT_OFFSET_MINUTES = 60;
