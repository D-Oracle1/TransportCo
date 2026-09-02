import { Router } from 'express';
import { z } from 'zod';
import { sosSchema, supportMessageSchema, supportTicketSchema } from '@transportco/validation';
import { asyncHandler, param, sendCreated, sendOk } from '../../lib/http';
import { validateBody, validateParams } from '../../middleware/validate';
import { authenticate, claimsOf } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { query, queryOne } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import { notify, notifyOps } from '../../services/notifications';
import { emitToOps } from '../../services/realtime/gateway';
import { getRouteProvider } from '../../services/maps';
import { env } from '../../config';
import { logger } from '../../lib/logger';

/**
 * Support and emergency.
 *
 * Open to any authenticated principal — a driver needs support and an SOS just
 * as much as a customer does, and the same ticket queue serves both.
 */
export const supportRouter = Router();

supportRouter.use(authenticate);

const idParams = z.object({ id: z.string().uuid() });

supportRouter.post(
  '/tickets',
  rateLimit({ bucket: 'support', max: 10, windowMs: 60 * 60_000 }),
  validateBody(supportTicketSchema),
  asyncHandler(async (req, res) => {
    const claims = claimsOf(req);

    // A safety report jumps the queue. Everything else is triaged normally.
    const priority = req.body.category === 'safety_issue' ? 'urgent' : 'normal';

    const sequence = await queryOne<{ value: number }>(
      "SELECT nextval('seq_ticket_reference')::int AS value",
    );

    const ticket = await queryOne<{ id: string; reference: string }>(
      `INSERT INTO support_tickets (
         reference, raised_by_user_id, customer_id, driver_id, trip_id, category, subject, priority
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, reference`,
      [
        `TKT-${String(sequence?.value ?? 1).padStart(5, '0')}`,
        claims.sub,
        claims.customerId ?? null,
        claims.driverId ?? null,
        req.body.tripId ?? null,
        req.body.category,
        req.body.subject,
        priority,
      ],
    );

    await query(
      `INSERT INTO support_messages (ticket_id, author_user_id, author_role, body)
       VALUES ($1, $2, $3, $4)`,
      [ticket!.id, claims.sub, claims.customerId ? 'customer' : 'driver', req.body.message],
    );

    sendCreated(res, { ticketId: ticket!.id, reference: ticket!.reference, status: 'OPEN', priority });
  }),
);

supportRouter.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    sendOk(
      res,
      await query(
        `SELECT t.id, t.reference, t.category, t.subject, t.status, t.priority, t.created_at,
                t.resolved_at, tr.reference AS trip_reference
           FROM support_tickets t
           LEFT JOIN trips tr ON tr.id = t.trip_id
          WHERE t.raised_by_user_id = $1
          ORDER BY t.created_at DESC
          LIMIT 50`,
        [claimsOf(req).sub],
      ),
    );
  }),
);

supportRouter.get(
  '/tickets/:id',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const claims = claimsOf(req);

    const ticket = await queryOne(
      'SELECT * FROM support_tickets WHERE id = $1 AND raised_by_user_id = $2',
      [param(req, 'id'), claims.sub],
    );
    if (!ticket) throw notFound('Ticket', param(req, 'id'));

    // `internal = false` is the whole point: agent notes exist and must never
    // reach the person the ticket is about.
    const messages = await query(
      `SELECT m.id, m.body, m.author_role, m.created_at, u.full_name AS author_name
         FROM support_messages m
         JOIN users u ON u.id = m.author_user_id
        WHERE m.ticket_id = $1 AND m.internal = false
        ORDER BY m.created_at ASC`,
      [param(req, 'id')],
    );

    sendOk(res, { ticket, messages });
  }),
);

supportRouter.post(
  '/tickets/:id/messages',
  validateParams(idParams),
  validateBody(supportMessageSchema.omit({ internal: true })),
  asyncHandler(async (req, res) => {
    const claims = claimsOf(req);

    const ticket = await queryOne<{ id: string; status: string }>(
      'SELECT id, status FROM support_tickets WHERE id = $1 AND raised_by_user_id = $2',
      [param(req, 'id'), claims.sub],
    );
    if (!ticket) throw notFound('Ticket', param(req, 'id'));
    if (ticket.status === 'CLOSED') {
      throw new AppError({ code: 'conflict', message: 'This ticket is closed. Please open a new one.' });
    }

    const message = await queryOne(
      `INSERT INTO support_messages (ticket_id, author_user_id, author_role, body, attachments)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, body, created_at`,
      [
        ticket.id,
        claims.sub,
        claims.customerId ? 'customer' : 'driver',
        req.body.body,
        JSON.stringify(req.body.attachments ?? []),
      ],
    );

    // A customer reply reopens a ticket that was waiting on them.
    await query(
      `UPDATE support_tickets
          SET status = CASE WHEN status = 'WAITING_FOR_CUSTOMER' THEN 'IN_PROGRESS' ELSE status END
        WHERE id = $1`,
      [ticket.id],
    );

    sendCreated(res, message);
  }),
);

/**
 * SOS.
 *
 * The incident row is written FIRST and everything else is best-effort after
 * it. If notifications are down, the incident still exists and operations will
 * see it on the board — losing an emergency because a push provider timed out
 * is not an acceptable failure mode.
 */
supportRouter.post(
  '/sos',
  rateLimit({ bucket: 'sos', max: 5, windowMs: 10 * 60_000 }),
  validateBody(sosSchema),
  asyncHandler(async (req, res) => {
    const claims = claimsOf(req);

    const sequence = await queryOne<{ value: number }>(
      "SELECT nextval('seq_incident_reference')::int AS value",
    );

    let locationAddress: string | null = null;
    if (req.body.latitude != null && req.body.longitude != null) {
      locationAddress = await getRouteProvider()
        .reverseGeocode({ latitude: req.body.latitude, longitude: req.body.longitude })
        .catch(() => null);
    }

    const incident = await queryOne<{ id: string; reference: string }>(
      `INSERT INTO emergency_incidents (
         reference, raised_by_user_id, raised_by_type, trip_id, driver_id, customer_id,
         type, latitude, longitude, location_address, note
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, reference`,
      [
        `SOS-${String(sequence?.value ?? 1).padStart(5, '0')}`,
        claims.sub,
        claims.driverId ? 'driver' : 'customer',
        req.body.tripId ?? null,
        claims.driverId ?? null,
        claims.customerId ?? null,
        req.body.type,
        req.body.latitude ?? null,
        req.body.longitude ?? null,
        locationAddress,
        req.body.note ?? null,
      ],
    );

    logger.error(
      { incidentId: incident!.id, userId: claims.sub, tripId: req.body.tripId },
      'EMERGENCY RAISED',
    );

    emitToOps('emergency.raised', {
      incidentId: incident!.id,
      reference: incident!.reference,
      type: req.body.type,
      location:
        req.body.latitude != null ? { latitude: req.body.latitude, longitude: req.body.longitude } : null,
      address: locationAddress,
      tripId: req.body.tripId ?? null,
    });

    await notifyOps(
      'admin.emergency_raised',
      { raisedBy: claims.driverId ? 'A driver' : 'A customer', location: locationAddress ?? 'unknown' },
      'emergency:read',
    ).catch(() => undefined);

    sendCreated(res, {
      incidentId: incident!.id,
      reference: incident!.reference,
      status: 'open',
      // Given to the app immediately so the user can call a human right now,
      // whether or not any of our systems respond.
      emergencyContact: env.OPS_EMERGENCY_HOTLINE,
      message: 'Operations has been alerted. Call the hotline if you are in immediate danger.',
    });
  }),
);

supportRouter.get(
  '/sos/:id',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const incident = await queryOne(
      'SELECT * FROM emergency_incidents WHERE id = $1 AND raised_by_user_id = $2',
      [param(req, 'id'), claimsOf(req).sub],
    );
    if (!incident) throw notFound('Incident', param(req, 'id'));
    sendOk(res, incident);
  }),
);
