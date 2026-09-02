import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import type { RealtimeEvent, RealtimeRoom } from '@transportco/types';
import { env } from '../../config';
import { logger } from '../../lib/logger';
import { verifyAccessToken } from '../../lib/tokens';

/**
 * REALTIME GATEWAY.
 *
 * Rooms are the authorisation boundary. A socket may join:
 *
 *   customer:<id>  only its own customer id
 *   driver:<id>    only its own driver id
 *   trip:<id>      only if it is a participant, or staff with trip:read
 *   ops            only staff with trip:read
 *
 * That check happens on the server at join time. A client asking to join
 * `trip:<someone-elses-id>` is refused — otherwise live driver locations and
 * customer pickup addresses would be readable by anyone with a valid token.
 *
 * Every envelope carries a per-room sequence number so a client that misses a
 * frame can detect the gap and refetch, instead of rendering a stale position
 * as if it were current.
 */

let io: SocketServer | null = null;
const sequences = new Map<string, number>();

function nextSequence(room: string): number {
  const next = (sequences.get(room) ?? 0) + 1;
  sequences.set(room, next);
  return next;
}

interface SocketClaims {
  userId: string;
  customerId?: string;
  driverId?: string;
  isOps: boolean;
}

export function initialiseRealtime(server: HttpServer): SocketServer {
  io = new SocketServer(server, {
    path: env.REALTIME_PATH,
    cors: { origin: env.CORS_ALLOWED_ORIGINS, credentials: true },
    // Nigerian mobile networks drop connections often; a generous ping window
    // avoids treating a tunnel change as a disconnect.
    pingInterval: 25_000,
    pingTimeout: 40_000,
    transports: ['websocket', 'polling'],
  });

  io.use((socket, next) => {
    const token =
      (socket.handshake.auth as { token?: string } | undefined)?.token ??
      socket.handshake.headers.authorization?.replace(/^Bearer /i, '');

    if (!token) {
      next(new Error('unauthenticated'));
      return;
    }

    try {
      const claims = verifyAccessToken(token);
      const socketClaims: SocketClaims = {
        userId: claims.sub,
        customerId: claims.customerId,
        driverId: claims.driverId,
        isOps: claims.permissions.includes('trip:read'),
      };
      (socket.data as { claims: SocketClaims }).claims = socketClaims;
      next();
    } catch {
      next(new Error('unauthenticated'));
    }
  });

  io.on('connection', (socket) => {
    const claims = (socket.data as { claims: SocketClaims }).claims;

    // Personal room: how a user receives notifications addressed to them.
    void socket.join(`user:${claims.userId}`);
    if (claims.customerId) void socket.join(`customer:${claims.customerId}`);
    if (claims.driverId) void socket.join(`driver:${claims.driverId}`);
    if (claims.isOps) void socket.join('ops');

    socket.on('trip:subscribe', async (tripId: unknown, ack?: (result: unknown) => void) => {
      if (typeof tripId !== 'string') {
        ack?.({ ok: false, error: 'invalid_trip_id' });
        return;
      }

      const allowed = await canJoinTrip(claims, tripId);
      if (!allowed) {
        logger.warn({ userId: claims.userId, tripId }, 'Refused realtime trip subscription');
        ack?.({ ok: false, error: 'forbidden' });
        return;
      }

      await socket.join(`trip:${tripId}`);
      ack?.({ ok: true });
    });

    socket.on('trip:unsubscribe', (tripId: unknown) => {
      if (typeof tripId === 'string') void socket.leave(`trip:${tripId}`);
    });

    socket.on('disconnect', (reason) => {
      logger.debug({ userId: claims.userId, reason }, 'Realtime client disconnected');
    });
  });

  logger.info({ path: env.REALTIME_PATH }, 'Realtime gateway ready');
  return io;
}

/**
 * Participation check. Kept as a query rather than trusting the token so that a
 * driver removed from a trip stops receiving its location immediately.
 */
async function canJoinTrip(claims: SocketClaims, tripId: string): Promise<boolean> {
  if (claims.isOps) return true;

  const { queryOne } = await import('../../db/pool');
  const trip = await queryOne<{ customer_id: string; driver_id: string | null }>(
    'SELECT customer_id, driver_id FROM trips WHERE id = $1',
    [tripId],
  );
  if (!trip) return false;

  if (claims.customerId && trip.customer_id === claims.customerId) return true;
  if (claims.driverId && trip.driver_id === claims.driverId) return true;
  return false;
}

function emit(room: RealtimeRoom | string, event: RealtimeEvent, payload: unknown): void {
  if (!io) return;

  io.to(room).emit(event, {
    event,
    room,
    at: new Date().toISOString(),
    sequence: nextSequence(room),
    payload,
  });
}

export function emitToTrip(tripId: string, event: RealtimeEvent, payload: unknown): void {
  emit(`trip:${tripId}`, event, payload);
}

export function emitToCustomer(customerId: string, event: RealtimeEvent, payload: unknown): void {
  emit(`customer:${customerId}`, event, payload);
}

export function emitToDriver(driverId: string, event: RealtimeEvent, payload: unknown): void {
  emit(`driver:${driverId}`, event, payload);
}

export function emitToOps(event: RealtimeEvent, payload: unknown): void {
  emit('ops', event, payload);
}

export function emitToUser(userId: string, event: RealtimeEvent, payload: unknown): void {
  emit(`user:${userId}`, event, payload);
}

export function shutdownRealtime(): void {
  io?.close();
  io = null;
  sequences.clear();
}
