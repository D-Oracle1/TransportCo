import type { ISODateTime, UUID } from './common';

/**
 * Notifications are event-driven. Domain code emits a typed event; the
 * NotificationService decides which channels to use based on the event's
 * default channel policy intersected with the recipient's preferences.
 */

export const NOTIFICATION_EVENTS = [
  // Customer
  'customer.ride_requested',
  'customer.fare_ready',
  'customer.counteroffer_received',
  'customer.offer_expiring',
  'customer.fare_accepted',
  'customer.fare_rejected',
  'customer.driver_assigned',
  'customer.driver_changed',
  'customer.driver_approaching',
  'customer.driver_arrived',
  'customer.trip_started',
  'customer.trip_completed',
  'customer.payment_received',
  'customer.payment_failed',
  'customer.loyalty_earned',
  'customer.scheduled_reminder',
  'customer.trip_cancelled',
  'customer.outstanding_balance',
  'customer.support_update',
  // Driver
  'driver.trip_assigned',
  'driver.trip_updated',
  'driver.trip_cancelled',
  'driver.trip_reassigned',
  'driver.scheduled_reminder',
  'driver.support_update',
  'driver.admin_alert',
  // Admin / ops
  'admin.negotiation_review_required',
  'admin.trip_unassigned',
  'admin.driver_unavailable',
  'admin.emergency_raised',
  'admin.payment_failed',
  'admin.fraud_signal',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export type NotificationChannel = 'push' | 'sms' | 'email' | 'whatsapp' | 'in_app';

export type NotificationStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'suppressed' | 'read';

export interface NotificationRecord {
  id: UUID;
  recipientUserId: UUID;
  event: NotificationEvent;
  channel: NotificationChannel;
  title: string;
  body: string;
  data: Record<string, unknown>;
  status: NotificationStatus;
  /** Prevents the same event firing twice for the same entity. */
  dedupeKey: string | null;
  failureReason: string | null;
  sentAt: ISODateTime | null;
  readAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface PushToken {
  id: UUID;
  userId: UUID;
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceId: string | null;
  active: boolean;
  lastSeenAt: ISODateTime;
  createdAt: ISODateTime;
}

// --- Realtime --------------------------------------------------------------

/**
 * Realtime rooms. A socket may only join rooms its token authorises:
 *  - customer:<customerId>  — own trips only
 *  - driver:<driverId>      — own assignments only
 *  - trip:<tripId>          — participants + ops
 *  - ops                    — authenticated staff with trip:read
 */
export type RealtimeRoom = `customer:${string}` | `driver:${string}` | `trip:${string}` | 'ops';

export const REALTIME_EVENTS = [
  'trip.status_changed',
  'trip.driver_assigned',
  'trip.driver_location',
  'trip.eta_updated',
  'negotiation.offer_created',
  'negotiation.offer_resolved',
  'negotiation.expired',
  'driver.state_changed',
  'driver.location',
  'emergency.raised',
  'notification.created',
] as const;

export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];

export interface RealtimeEnvelope<T = unknown> {
  event: RealtimeEvent;
  room: RealtimeRoom;
  /** Server clock. Clients must not trust their own for ordering. */
  at: ISODateTime;
  /** Monotonic per room, so a client can detect a gap and refetch. */
  sequence: number;
  payload: T;
}
