import type { GeoPoint } from '@transportco/types';

const EARTH_RADIUS_METRES = 6_371_000;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in metres. Used for dispatch scoring and geofences. */
export function haversineMetres(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h))));
}

export function isWithinRadius(point: GeoPoint, centre: GeoPoint, radiusMetres: number): boolean {
  return haversineMetres(point, centre) <= radiusMetres;
}

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

export function formatDistance(metres: number): string {
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/**
 * Straight-line speed between two fixes, in metres per second. A value far
 * above road speed is the primary GPS-spoofing signal.
 */
export function speedBetween(a: GeoPoint, aAt: Date, b: GeoPoint, bAt: Date): number | null {
  const elapsedSeconds = (bAt.getTime() - aAt.getTime()) / 1000;
  if (elapsedSeconds <= 0) return null;
  return haversineMetres(a, b) / elapsedSeconds;
}
