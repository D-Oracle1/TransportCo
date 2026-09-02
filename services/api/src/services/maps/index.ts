import type { GeoPoint, RouteEstimate } from '@transportco/types';
import { haversineMetres, retry } from '@transportco/utils';
import { env } from '../../config';
import { logger } from '../../lib/logger';
import { AppError } from '../../lib/errors';

/**
 * Routing and geocoding.
 *
 * The pricing engine needs a distance and a duration; where they come from is
 * an implementation detail behind this interface. The mock provider is for
 * development and tests — it is deterministic and costs nothing — and the
 * Google provider is the production path.
 *
 * The mock is NOT a fake success: it derives a real straight-line distance and
 * a plausible duration, and it says so in `provider`, so a fare priced from it
 * is always identifiable as such. Production configuration refuses to boot with
 * the mock selected (see packages/config).
 */

export interface RouteProvider {
  readonly name: 'google' | 'mock';
  estimateRoute(origin: GeoPoint, destination: GeoPoint, departAt?: Date): Promise<RouteEstimate>;
  reverseGeocode(point: GeoPoint): Promise<string | null>;
}

/**
 * Straight-line distance inflated by a road-network factor, plus a duration
 * derived from a realistic urban average speed. Good enough to develop and test
 * against; never good enough to bill a real customer, which is why production
 * cannot select it.
 */
const ROAD_NETWORK_FACTOR = 1.35;
const URBAN_AVERAGE_SPEED_MPS = 7.8; // ~28 km/h through Port Harcourt

export class MockRouteProvider implements RouteProvider {
  readonly name = 'mock' as const;

  async estimateRoute(origin: GeoPoint, destination: GeoPoint): Promise<RouteEstimate> {
    const straightLine = haversineMetres(origin, destination);
    const distanceMeters = Math.round(straightLine * ROAD_NETWORK_FACTOR);

    return {
      distanceMeters,
      durationSeconds: Math.round(distanceMeters / URBAN_AVERAGE_SPEED_MPS),
      polyline: null,
      provider: 'mock',
    };
  }

  async reverseGeocode(point: GeoPoint): Promise<string | null> {
    return `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
  }
}

interface GoogleDirectionsResponse {
  status: string;
  error_message?: string;
  routes: Array<{
    overview_polyline?: { points: string };
    legs: Array<{
      distance: { value: number };
      duration: { value: number };
      duration_in_traffic?: { value: number };
    }>;
  }>;
}

export class GoogleRouteProvider implements RouteProvider {
  readonly name = 'google' as const;

  constructor(private readonly apiKey: string) {}

  async estimateRoute(origin: GeoPoint, destination: GeoPoint, departAt?: Date): Promise<RouteEstimate> {
    const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
    url.searchParams.set('origin', `${origin.latitude},${origin.longitude}`);
    url.searchParams.set('destination', `${destination.latitude},${destination.longitude}`);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('region', 'ng');
    url.searchParams.set('key', this.apiKey);
    // Traffic-aware duration matters: a 20-minute route at 08:00 in Port
    // Harcourt is not a 20-minute route, and a fare priced on the free-flow
    // number underpays the driver's time.
    url.searchParams.set(
      'departure_time',
      departAt ? String(Math.floor(departAt.getTime() / 1000)) : 'now',
    );

    const response = await retry(
      async () => {
        const result = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!result.ok) throw new Error(`Directions API returned ${result.status}`);
        return (await result.json()) as GoogleDirectionsResponse;
      },
      {
        attempts: 3,
        onRetry: (attempt, error) => logger.warn({ attempt, err: error }, 'Retrying Directions API'),
      },
    ).catch((error: unknown) => {
      throw new AppError({
        code: 'provider_unavailable',
        message: 'We could not work out the route just now. Please try again.',
        cause: error,
      });
    });

    if (response.status !== 'OK' || response.routes.length === 0) {
      throw new AppError({
        code: 'validation_failed',
        message: 'We could not find a driving route between those points',
        logContext: { status: response.status, error: response.error_message },
      });
    }

    const legs = response.routes[0]!.legs;
    const distanceMeters = legs.reduce((total, leg) => total + leg.distance.value, 0);
    const durationSeconds = legs.reduce(
      (total, leg) => total + (leg.duration_in_traffic?.value ?? leg.duration.value),
      0,
    );

    return {
      distanceMeters,
      durationSeconds,
      polyline: response.routes[0]!.overview_polyline?.points ?? null,
      provider: 'google',
    };
  }

  async reverseGeocode(point: GeoPoint): Promise<string | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${point.latitude},${point.longitude}`);
    url.searchParams.set('key', this.apiKey);

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6_000) });
      const body = (await response.json()) as { results?: Array<{ formatted_address: string }> };
      return body.results?.[0]?.formatted_address ?? null;
    } catch (error) {
      // A missing address label is cosmetic; never fail a booking over it.
      logger.warn({ err: error }, 'Reverse geocode failed');
      return null;
    }
  }
}

let provider: RouteProvider | null = null;

export function getRouteProvider(): RouteProvider {
  if (provider) return provider;

  if (env.GOOGLE_MAPS_PROVIDER === 'google') {
    if (!env.GOOGLE_MAPS_API_KEY) {
      throw new Error('GOOGLE_MAPS_PROVIDER=google requires GOOGLE_MAPS_API_KEY');
    }
    provider = new GoogleRouteProvider(env.GOOGLE_MAPS_API_KEY);
  } else {
    logger.warn('Using the MOCK route provider — fares are estimates, not production prices');
    provider = new MockRouteProvider();
  }

  return provider;
}

/** Test seam. */
export function setRouteProvider(next: RouteProvider | null): void {
  provider = next;
}
