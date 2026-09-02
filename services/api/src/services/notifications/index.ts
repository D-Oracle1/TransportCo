import type { NotificationChannel, NotificationEvent } from '@transportco/types';
import { query, queryOne } from '../../db/pool';
import { logger } from '../../lib/logger';
import { env } from '../../config';
import { emitToUser } from '../realtime/gateway';

/**
 * NOTIFICATION SERVICE.
 *
 * Domain code emits an EVENT; it never picks a channel. This module decides
 * how an event reaches a person, by intersecting:
 *
 *   event default channels  ∩  recipient preferences  ∩  configured providers
 *
 * Why that ordering matters: "driver has arrived" must be a push notification
 * even for a customer who muted marketing email, and an SMS costs real money
 * per message, so it is reserved for events where a missed message means a
 * missed trip.
 *
 * Every send is recorded in `notifications` with a dedupe key, so a retried
 * handler cannot text a customer twice about the same arrival.
 */

interface EventPolicy {
  channels: NotificationChannel[];
  /** Channels that ignore recipient preferences — safety and money. */
  mandatory?: NotificationChannel[];
  title: (data: Record<string, unknown>) => string;
  body: (data: Record<string, unknown>) => string;
}

const str = (value: unknown, fallback = ''): string => (value == null ? fallback : String(value));

/**
 * The channel policy. Deliberately conservative on SMS: at launch scale, an
 * SMS to every customer for every status change is both expensive and the
 * fastest way to get an app muted.
 */
const POLICIES: Partial<Record<NotificationEvent, EventPolicy>> = {
  'customer.fare_ready': {
    channels: ['push', 'in_app'],
    title: () => 'Your fare is ready',
    body: (d) => `${str(d.route, 'Your trip')} — ${str(d.fare)}`,
  },
  'customer.counteroffer_received': {
    channels: ['push', 'in_app'],
    title: () => 'We have a counteroffer',
    body: (d) => `We can do ${str(d.amount)} for this trip. This offer expires shortly.`,
  },
  'customer.offer_expiring': {
    channels: ['push'],
    title: () => 'Your offer is about to expire',
    body: (d) => `Respond within ${str(d.minutes, 'a few')} minutes to keep this fare.`,
  },
  'customer.fare_accepted': {
    channels: ['push', 'in_app'],
    title: () => 'Fare agreed',
    body: (d) => `Your fare is ${str(d.fare)}. We are finding your driver now.`,
  },
  'customer.fare_rejected': {
    channels: ['push', 'in_app'],
    title: () => 'About your offer',
    body: (d) => `We could not accept that offer. Our price is ${str(d.amount)}.`,
  },
  'customer.driver_assigned': {
    channels: ['push', 'in_app'],
    mandatory: ['push'],
    title: () => 'Your driver is assigned',
    body: (d) => `${str(d.driverName)} is coming in a ${str(d.vehicle)} (${str(d.plate)}).`,
  },
  'customer.driver_changed': {
    channels: ['push', 'in_app', 'sms'],
    mandatory: ['push'],
    title: () => 'Your driver has changed',
    body: (d) => `${str(d.driverName)} will now pick you up. We are sorry for the change.`,
  },
  'customer.driver_approaching': {
    channels: ['push'],
    title: () => 'Your driver is nearby',
    body: (d) => `${str(d.driverName)} is about ${str(d.minutes)} minutes away.`,
  },
  'customer.driver_arrived': {
    channels: ['push', 'sms'],
    mandatory: ['push', 'sms'],
    title: () => 'Your driver has arrived',
    body: (d) => `${str(d.driverName)} is waiting in a ${str(d.vehicle)} (${str(d.plate)}).`,
  },
  'customer.trip_started': {
    channels: ['push', 'in_app'],
    title: () => 'Trip started',
    body: () => 'Enjoy your trip. Share your ride from the trip screen if you would like.',
  },
  'customer.trip_completed': {
    channels: ['push', 'in_app'],
    title: () => 'Trip completed',
    body: (d) => `Your fare is ${str(d.fare)}. Thank you for riding with us.`,
  },
  'customer.payment_received': {
    channels: ['push', 'in_app'],
    title: () => 'Payment received',
    body: (d) => `We have received ${str(d.amount)}.`,
  },
  'customer.payment_failed': {
    channels: ['push', 'in_app', 'sms'],
    mandatory: ['push'],
    title: () => 'Payment could not be completed',
    body: () => 'Please try again or choose another payment method.',
  },
  'customer.loyalty_earned': {
    channels: ['in_app'],
    title: () => 'Points earned',
    body: (d) => `You earned ${str(d.points)} points on that trip.`,
  },
  'customer.scheduled_reminder': {
    channels: ['push', 'sms'],
    mandatory: ['push'],
    title: () => 'Your scheduled trip is coming up',
    body: (d) => `${str(d.driverName)} will pick you up at ${str(d.time)}.`,
  },
  'customer.trip_cancelled': {
    channels: ['push', 'in_app'],
    mandatory: ['push'],
    title: () => 'Trip cancelled',
    body: (d) => str(d.reason, 'Your trip has been cancelled.'),
  },
  'customer.outstanding_balance': {
    channels: ['push', 'in_app'],
    title: () => 'Outstanding balance',
    body: (d) => `You have ${str(d.amount)} outstanding. Settle it to book your next ride.`,
  },
  'customer.support_update': {
    channels: ['push', 'in_app'],
    title: () => 'Support update',
    body: (d) => `We have replied to your ticket ${str(d.reference)}.`,
  },

  'driver.trip_assigned': {
    channels: ['push', 'in_app'],
    mandatory: ['push'],
    title: () => 'New trip',
    body: (d) => `Pick up ${str(d.customerName)} at ${str(d.pickup)}.`,
  },
  'driver.trip_updated': {
    channels: ['push', 'in_app'],
    title: () => 'Trip updated',
    body: (d) => str(d.message, 'One of your trips has changed.'),
  },
  'driver.trip_cancelled': {
    channels: ['push', 'in_app'],
    mandatory: ['push'],
    title: () => 'Trip cancelled',
    body: (d) => `Trip ${str(d.reference)} has been cancelled.`,
  },
  'driver.trip_reassigned': {
    channels: ['push', 'in_app'],
    mandatory: ['push'],
    title: () => 'Trip reassigned',
    body: (d) => `Trip ${str(d.reference)} has been given to another driver.`,
  },
  'driver.scheduled_reminder': {
    channels: ['push', 'in_app'],
    title: () => 'Scheduled trip coming up',
    body: (d) => `Pick up ${str(d.customerName)} at ${str(d.time)}.`,
  },
  'driver.support_update': {
    channels: ['push', 'in_app'],
    title: () => 'Support update',
    body: () => 'Your support ticket has been updated.',
  },
  'driver.admin_alert': {
    channels: ['push', 'in_app'],
    mandatory: ['push'],
    title: () => 'Message from operations',
    body: (d) => str(d.message),
  },

  'admin.negotiation_review_required': {
    channels: ['in_app'],
    title: () => 'Negotiation needs a decision',
    body: (d) => `${str(d.reference)}: customer offered ${str(d.amount)}.`,
  },
  'admin.trip_unassigned': {
    channels: ['in_app'],
    title: () => 'Trip waiting for a driver',
    body: (d) => `${str(d.reference)} has no driver assigned.`,
  },
  'admin.driver_unavailable': {
    channels: ['in_app'],
    title: () => 'Driver unavailable',
    body: (d) => `${str(d.driverName)} can no longer take ${str(d.reference)}.`,
  },
  'admin.emergency_raised': {
    channels: ['in_app', 'sms'],
    mandatory: ['in_app', 'sms'],
    title: () => 'SOS RAISED',
    body: (d) => `${str(d.raisedBy)} raised an emergency near ${str(d.location)}.`,
  },
  'admin.payment_failed': {
    channels: ['in_app'],
    title: () => 'Payment failed',
    body: (d) => `${str(d.reference)}: ${str(d.amount)} failed.`,
  },
  'admin.fraud_signal': {
    channels: ['in_app'],
    title: () => 'Fraud signal',
    body: (d) => `${str(d.code)} on ${str(d.subject)}.`,
  },
};

// --- Channel adapters ------------------------------------------------------

export interface ChannelAdapter {
  readonly channel: NotificationChannel;
  send(args: {
    userId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
  }): Promise<{ delivered: boolean; reason?: string }>;
}

/** Development default. Logs instead of sending, and never pretends it sent. */
class LogAdapter implements ChannelAdapter {
  constructor(readonly channel: NotificationChannel) {}

  async send(args: { userId: string; title: string; body: string }): Promise<{ delivered: boolean; reason?: string }> {
    logger.info({ channel: this.channel, userId: args.userId, title: args.title }, args.body);
    return { delivered: false, reason: 'log_driver' };
  }
}

/** In-app notifications need no external provider — the row IS the delivery. */
class InAppAdapter implements ChannelAdapter {
  readonly channel = 'in_app' as const;

  async send(args: { userId: string; title: string; body: string; data: Record<string, unknown> }): Promise<{ delivered: boolean }> {
    emitToUser(args.userId, 'notification.created', {
      title: args.title,
      body: args.body,
      data: args.data,
    });
    return { delivered: true };
  }
}

class ExpoPushAdapter implements ChannelAdapter {
  readonly channel = 'push' as const;

  constructor(private readonly accessToken?: string) {}

  async send(args: {
    userId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
  }): Promise<{ delivered: boolean; reason?: string }> {
    const tokens = await query<{ token: string }>(
      'SELECT token FROM push_tokens WHERE user_id = $1 AND active',
      [args.userId],
    );

    if (tokens.length === 0) return { delivered: false, reason: 'no_device_token' };

    const messages = tokens.map((row) => ({
      to: row.token,
      title: args.title,
      body: args.body,
      data: args.data,
      sound: 'default',
      priority: 'high',
    }));

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(8_000),
      });

      if (!response.ok) return { delivered: false, reason: `expo_${response.status}` };
      return { delivered: true };
    } catch (error) {
      logger.warn({ err: error }, 'Push delivery failed');
      return { delivered: false, reason: 'push_provider_error' };
    }
  }
}

function buildAdapters(): Map<NotificationChannel, ChannelAdapter> {
  const adapters = new Map<NotificationChannel, ChannelAdapter>();
  adapters.set('in_app', new InAppAdapter());

  if (env.NOTIFICATIONS_DRIVER === 'live') {
    adapters.set('push', new ExpoPushAdapter(env.EXPO_PUSH_ACCESS_TOKEN));
    // SMS, email and WhatsApp providers are wired here once credentials exist.
    // Until then they fall back to the log adapter rather than silently
    // claiming a delivery that never happened.
    adapters.set('sms', new LogAdapter('sms'));
    adapters.set('email', new LogAdapter('email'));
    adapters.set('whatsapp', new LogAdapter('whatsapp'));
  } else {
    adapters.set('push', new LogAdapter('push'));
    adapters.set('sms', new LogAdapter('sms'));
    adapters.set('email', new LogAdapter('email'));
    adapters.set('whatsapp', new LogAdapter('whatsapp'));
  }

  return adapters;
}

const adapters = buildAdapters();

export interface NotifyInput {
  userId: string;
  event: NotificationEvent;
  data?: Record<string, unknown>;
  /** Makes the send idempotent, e.g. `trip:<id>:driver_arrived`. */
  dedupeKey?: string;
  /** Overrides the policy — used only where a caller genuinely knows better. */
  channels?: NotificationChannel[];
}

export async function notify(input: NotifyInput): Promise<void> {
  const policy = POLICIES[input.event];
  if (!policy) {
    logger.warn({ event: input.event }, 'No notification policy for event; nothing sent');
    return;
  }

  const data = input.data ?? {};
  const title = policy.title(data);
  const body = policy.body(data);

  const preferences = await queryOne<{ preferences: Record<string, boolean> }>(
    `SELECT c.notification_preferences AS preferences
       FROM customers c WHERE c.user_id = $1`,
    [input.userId],
  );

  const requested = input.channels ?? policy.channels;
  const mandatory = new Set(policy.mandatory ?? []);

  const channels = requested.filter((channel) => {
    if (channel === 'in_app') return true; // always available, always free
    if (mandatory.has(channel)) return true; // safety and money override preferences
    if (!preferences) return true; // staff and drivers have no preference record yet
    return preferences.preferences[channel] !== false;
  });

  for (const channel of channels) {
    const adapter = adapters.get(channel);
    if (!adapter) continue;

    const dedupeKey = input.dedupeKey ? `${input.dedupeKey}:${channel}` : null;

    // The row is written FIRST. If delivery fails we still know we intended to
    // tell this person something, which is what support needs to answer "did
    // anyone tell the customer?".
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO notifications (recipient_user_id, event, channel, title, body, data, status, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [input.userId, input.event, channel, title, body, JSON.stringify(data), dedupeKey],
    );

    if (!inserted) continue; // deduplicated: already sent

    try {
      const result = await adapter.send({ userId: input.userId, title, body, data });
      await query(
        `UPDATE notifications
            SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
                failure_reason = $3
          WHERE id = $1`,
        [inserted.id, result.delivered ? 'sent' : 'failed', result.reason ?? null],
      );
    } catch (error) {
      logger.error({ err: error, event: input.event, channel }, 'Notification delivery threw');
      await query('UPDATE notifications SET status = $2, failure_reason = $3 WHERE id = $1', [
        inserted.id,
        'failed',
        'adapter_exception',
      ]).catch(() => undefined);
    }
  }
}

/** Fan-out to every member of staff holding a permission — used for ops alerts. */
export async function notifyOps(
  event: NotificationEvent,
  data: Record<string, unknown>,
  permission = 'trip:read',
): Promise<void> {
  const recipients = await query<{ user_id: string }>(
    `SELECT DISTINCT ur.user_id
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN users u ON u.id = ur.user_id
      WHERE rp.permission_key = $1 AND u.status = 'active' AND u.deleted_at IS NULL`,
    [permission],
  );

  await Promise.all(
    recipients.map((row) => notify({ userId: row.user_id, event, data }).catch(() => undefined)),
  );
}
