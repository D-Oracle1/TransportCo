import * as Location from 'expo-location';
import { OPERATIONS_DEFAULTS } from '@transportco/config';
import { api } from './api';

/**
 * DRIVER LOCATION REPORTING.
 *
 * The design constraint that shapes this file: a driver's phone must survive a
 * ten-hour shift. Reporting every second would be accurate and useless, because
 * a dead phone reports nothing at all.
 *
 * So the cadence ADAPTS to what is actually happening:
 *
 *   ON_TRIP / PICKING_UP   10s  — a customer is watching this dot move
 *   ASSIGNED               20s  — they are waiting to see the driver set off
 *   ARRIVED                30s  — parked; position barely changes
 *   AVAILABLE              45s  — only dispatch needs this, and not urgently
 *   idle/offline          120s  — a heartbeat, nothing more
 *
 * Fixes recorded while the network is down are QUEUED and flushed on
 * reconnection. The server treats a replayed fix as history, never as the
 * driver's current position — otherwise a flush after a tunnel would teleport
 * the driver backwards on the customer's map.
 */

export type ReportingState = 'OFFLINE' | 'AVAILABLE' | 'ASSIGNED' | 'PICKING_UP' | 'ARRIVED' | 'ON_TRIP';

interface QueuedPing {
  latitude: number;
  longitude: number;
  headingDegrees: number | null;
  speedMetresPerSecond: number | null;
  accuracyMetres: number | null;
  recordedAt: string;
  tripId: string | null;
}

const INTERVALS: Record<ReportingState, number> = {
  ON_TRIP: OPERATIONS_DEFAULTS.locationPingSeconds.ON_TRIP * 1000,
  PICKING_UP: OPERATIONS_DEFAULTS.locationPingSeconds.PICKING_UP * 1000,
  ASSIGNED: OPERATIONS_DEFAULTS.locationPingSeconds.ASSIGNED * 1000,
  ARRIVED: OPERATIONS_DEFAULTS.locationPingSeconds.ARRIVED * 1000,
  AVAILABLE: OPERATIONS_DEFAULTS.locationPingSeconds.AVAILABLE * 1000,
  OFFLINE: OPERATIONS_DEFAULTS.locationPingSeconds.IDLE * 1000,
};

/** Fixes are kept only while they are still operationally useful. */
const MAX_QUEUE = 200;

class LocationReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: ReportingState = 'OFFLINE';
  private tripId: string | null = null;
  private queue: QueuedPing[] = [];
  private sending = false;
  private listeners = new Set<(online: boolean, queued: number) => void>();
  private online = true;

  onStatusChange(listener: (online: boolean, queued: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.online, this.queue.length);
  }

  async requestPermissions(): Promise<{ granted: boolean; background: boolean }> {
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (foreground.status !== 'granted') return { granted: false, background: false };

    // Background permission is requested but NOT required: a driver who declines
    // it still works, they simply stop reporting when the app is backgrounded.
    let background = false;
    try {
      const result = await Location.requestBackgroundPermissionsAsync();
      background = result.status === 'granted';
    } catch {
      background = false;
    }

    return { granted: true, background };
  }

  /** Switches cadence. Called whenever the driver or trip state changes. */
  setState(state: ReportingState, tripId: string | null = null): void {
    const changed = this.state !== state || this.tripId !== tripId;
    this.state = state;
    this.tripId = tripId;

    if (state === 'OFFLINE') {
      this.stop();
      return;
    }

    if (changed || !this.timer) this.restart();
  }

  private restart(): void {
    this.stop();

    const interval = INTERVALS[this.state];
    void this.capture();

    this.timer = setInterval(() => {
      void this.capture();
    }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async capture(): Promise<void> {
    try {
      const position = await Location.getCurrentPositionAsync({
        // Balanced accuracy while merely available; the precise fix is only
        // worth its battery cost when someone is actually watching.
        accuracy:
          this.state === 'ON_TRIP' || this.state === 'PICKING_UP'
            ? Location.Accuracy.High
            : Location.Accuracy.Balanced,
      });

      this.queue.push({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        headingDegrees: position.coords.heading ?? null,
        speedMetresPerSecond: position.coords.speed ?? null,
        accuracyMetres: position.coords.accuracy ?? null,
        recordedAt: new Date(position.timestamp).toISOString(),
        tripId: this.tripId,
      });

      if (this.queue.length > MAX_QUEUE) this.queue = this.queue.slice(-MAX_QUEUE);

      await this.flush();
    } catch {
      // A failed fix is normal indoors or in a covered car park. The next tick
      // tries again; nothing is escalated.
    }
  }

  /** Sends queued fixes. Batches when there is a backlog from being offline. */
  async flush(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;

    this.sending = true;
    const batch = [...this.queue];

    try {
      if (batch.length === 1) {
        await api.post('/drivers/me/location', batch[0]);
      } else {
        await api.post('/drivers/me/location/batch', { points: batch });
      }

      this.queue = this.queue.slice(batch.length);
      if (!this.online) {
        this.online = true;
        this.notify();
      }
    } catch {
      // Keep the queue: this is precisely the case it exists for.
      if (this.online) {
        this.online = false;
        this.notify();
      }
    } finally {
      this.sending = false;
    }
  }

  get queueSize(): number {
    return this.queue.length;
  }

  get isOnline(): boolean {
    return this.online;
  }
}

export const locationReporter = new LocationReporter();
