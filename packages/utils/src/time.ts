import type { ISODateTime } from '@transportco/types';

/** West Africa Time. Rivers State does not observe daylight saving. */
export const OPERATING_TIMEZONE_OFFSET_MINUTES = 60;

export function toISO(date: Date): ISODateTime {
  return date.toISOString();
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addMinutes(date: Date, minutes: number): Date {
  return addSeconds(date, minutes * 60);
}

export function secondsBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 1000);
}

export function isPast(date: Date, now: Date = new Date()): boolean {
  return date.getTime() <= now.getTime();
}

/**
 * Local wall-clock parts for the operating timezone. Pricing windows ("night
 * rate starts at 22:00") are evaluated in local time, never UTC — otherwise a
 * server in another region would price Port Harcourt evenings wrong.
 */
export function localParts(
  date: Date,
  offsetMinutes: number = OPERATING_TIMEZONE_OFFSET_MINUTES,
): { weekday: number; minuteOfDay: number; isoDate: string } {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const weekday = shifted.getUTCDay();
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const isoDate = shifted.toISOString().slice(0, 10);
  return { weekday, minuteOfDay, isoDate };
}

/** Windows may wrap midnight (22:00 -> 05:00), so the comparison is not a simple range. */
export function isMinuteInWindow(minuteOfDay: number, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return false;
  if (startMinute < endMinute) return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

/** "in 4 min", "in 2 hr", "now" — used for countdowns and ETA labels. */
export function humanizeCountdown(seconds: number): string {
  if (seconds <= 0) return 'expired';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}:${String(rest).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
