/**
 * Primitive, cross-cutting types.
 *
 * MONEY RULE (platform-wide, non-negotiable):
 * every monetary amount is an INTEGER in the currency's MINOR UNIT (kobo for
 * NGN). Floating point never touches money. Formatting to "₦7,400.00" happens
 * only at the presentation edge via `formatMoney()` in @transportco/utils.
 */

/** UUID v4 string. Branded so an ID can never be passed where a name is wanted. */
export type UUID = string & { readonly __uuid?: unique symbol };

/** Amount in minor units (kobo). 740_000 === ₦7,400.00 */
export type MinorUnits = number;

export type CurrencyCode = 'NGN';

export interface Money {
  /** Integer amount in minor units. */
  amount: MinorUnits;
  currency: CurrencyCode;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface Place extends GeoPoint {
  /** Human readable address as shown to the user. */
  address: string;
  /** Google Places identifier when the point came from Places autocomplete. */
  placeId?: string | null;
}

/** Result of a routing provider lookup (Google Directions or the mock provider). */
export interface RouteEstimate {
  distanceMeters: number;
  durationSeconds: number;
  /** Encoded polyline for map rendering. */
  polyline?: string | null;
  provider: 'google' | 'mock' | 'haversine';
}

export type ISODateTime = string;

export interface Timestamps {
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface SoftDeletable {
  deletedAt: ISODateTime | null;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

/** Nigerian operating zone (Rivers State first). Zones drive pricing + dispatch. */
export interface Zone {
  id: UUID;
  code: string;
  name: string;
  /** Simple circular zone for Phase 1; polygon support is additive later. */
  center: GeoPoint;
  radiusMeters: number;
  active: boolean;
}
