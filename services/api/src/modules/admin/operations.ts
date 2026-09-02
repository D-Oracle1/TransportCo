import { Router } from 'express';
import { z } from 'zod';
import {
  adminNegotiationResponseSchema,
  assignDriverSchema,
  cancelTripSchema,
  pageQuerySchema,
} from '@transportco/validation';
import { formatMoney } from '@transportco/utils';
import { asyncHandler, paginate, param, sendOk } from '../../lib/http';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate';
import { authenticate, claimsOf, requirePermission } from '../../middleware/auth';
import { query, queryOne } from '../../db/pool';
import { notFound } from '../../lib/errors';
import { hasPermission } from '../../domain/rbac/access';
import { assignDriver, dispatchBoard, markDriverUnavailable, recommendDrivers } from '../dispatch/service';
import { negotiationDetail, respondAsAdmin, reviewQueue } from '../negotiation/service';
import { cancelTrip } from '../trips/service';
import { tripHistory } from '../trips/repository';

/**
 * Operations console API: the dashboard, the live map, trips, dispatch and the
 * negotiation workspace.
 *
 * Every route names the permission it needs. A dispatcher can assign drivers
 * and cannot see payroll; that separation is enforced here rather than by
 * hiding buttons in the web app.
 */
export const adminOperationsRouter = Router();

adminOperationsRouter.use(authenticate);

const idParams = z.object({ id: z.string().uuid() });

// --- Dashboard -------------------------------------------------------------

adminOperationsRouter.get(
  '/dashboard',
  requirePermission('trip:read'),
  asyncHandler(async (_req, res) => {
    // One round trip. The dashboard is polled by every open console, so it must
    // not become a fan of a dozen sequential queries.
    const stats = await queryOne<Record<string, number>>(
      `SELECT
         (SELECT count(*) FROM trips WHERE status IN ('DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED'))::int AS active_trips,
         (SELECT count(*) FROM negotiations WHERE status = 'AWAITING_COMPANY')::int AS pending_negotiations,
         (SELECT count(*) FROM trips WHERE driver_id IS NULL AND status IN ('FARE_LOCKED','DRIVER_UNAVAILABLE'))::int AS unassigned_trips,
         (SELECT count(*) FROM scheduled_rides WHERE status IN ('scheduled','reassigned') AND scheduled_pickup_at > now())::int AS scheduled_trips,
         (SELECT count(*) FROM drivers WHERE state = 'AVAILABLE' AND deleted_at IS NULL)::int AS available_drivers,
         (SELECT count(*) FROM drivers WHERE state IN ('ASSIGNED','PICKING_UP','ARRIVED','ON_TRIP') AND deleted_at IS NULL)::int AS busy_drivers,
         (SELECT count(*) FROM drivers WHERE state = 'OFFLINE' AND deleted_at IS NULL)::int AS offline_drivers,
         (SELECT count(*) FROM trips WHERE status = 'COMPLETED' AND completed_at >= date_trunc('day', now()))::int AS completed_today,
         (SELECT count(*) FROM trips WHERE status = 'CANCELLED' AND cancelled_at >= date_trunc('day', now()))::int AS cancelled_today,
         (SELECT COALESCE(SUM(amount_minor), 0) FROM payments WHERE status = 'succeeded' AND paid_at >= date_trunc('day', now()))::bigint AS revenue_today,
         (SELECT COALESCE(SUM(amount_minor - settled_amount_minor), 0) FROM outstanding_balances WHERE status IN ('outstanding','partially_settled'))::bigint AS outstanding_total,
         (SELECT count(*) FROM support_tickets WHERE status IN ('OPEN','IN_PROGRESS'))::int AS open_tickets,
         (SELECT count(*) FROM emergency_incidents WHERE status IN ('open','acknowledged','responding'))::int AS open_incidents,
         (SELECT count(*) FROM fraud_signals WHERE status = 'open' AND severity IN ('warning','critical'))::int AS open_fraud_signals`,
    );

    sendOk(res, {
      activeTrips: stats?.active_trips ?? 0,
      pendingNegotiations: stats?.pending_negotiations ?? 0,
      unassignedTrips: stats?.unassigned_trips ?? 0,
      scheduledTrips: stats?.scheduled_trips ?? 0,
      drivers: {
        available: stats?.available_drivers ?? 0,
        busy: stats?.busy_drivers ?? 0,
        offline: stats?.offline_drivers ?? 0,
      },
      completedToday: stats?.completed_today ?? 0,
      cancelledToday: stats?.cancelled_today ?? 0,
      revenueTodayMinor: Number(stats?.revenue_today ?? 0),
      revenueTodayLabel: formatMoney(Number(stats?.revenue_today ?? 0)),
      outstandingTotalMinor: Number(stats?.outstanding_total ?? 0),
      openTickets: stats?.open_tickets ?? 0,
      openIncidents: stats?.open_incidents ?? 0,
      openFraudSignals: stats?.open_fraud_signals ?? 0,
    });
  }),
);

/** Live operations map: every driver with a recent fix, plus the trip they carry. */
adminOperationsRouter.get(
  '/live',
  requirePermission('trip:read'),
  asyncHandler(async (_req, res) => {
    const [drivers, trips, incidents] = await Promise.all([
      query(
        `SELECT d.id AS driver_id, u.full_name, d.state, d.rating,
                d.last_latitude AS latitude, d.last_longitude AS longitude,
                d.last_heading AS heading, d.last_location_at,
                v.plate_number, v.make, v.model,
                t.id AS trip_id, t.reference AS trip_reference, t.status AS trip_status
           FROM drivers d
           JOIN employees e ON e.id = d.employee_id
           JOIN users u ON u.id = e.user_id
           LEFT JOIN vehicles v ON v.id = d.assigned_vehicle_id
           LEFT JOIN trips t ON t.driver_id = d.id
             AND t.status IN ('DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED')
          WHERE d.deleted_at IS NULL AND d.state <> 'OFFLINE'`,
      ),
      query(
        `SELECT t.id, t.reference, t.status, t.pickup_lat, t.pickup_lng, t.pickup_address,
                t.destination_lat, t.destination_lng, t.destination_address,
                t.final_fare_minor, t.driver_id, u.full_name AS customer_name
           FROM trips t
           JOIN customers c ON c.id = t.customer_id
           JOIN users u ON u.id = c.user_id
          WHERE t.status IN ('FARE_LOCKED','DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED')`,
      ),
      query(
        `SELECT id, reference, type, status, latitude, longitude, location_address, created_at
           FROM emergency_incidents
          WHERE status IN ('open','acknowledged','responding')`,
      ),
    ]);

    sendOk(res, { drivers, trips, incidents, at: new Date().toISOString() });
  }),
);

// --- Trips -----------------------------------------------------------------

adminOperationsRouter.get(
  '/trips',
  requirePermission('trip:read'),
  validateQuery(
    pageQuerySchema.extend({
      status: z.string().optional(),
      search: z.string().max(80).optional(),
      driverId: z.string().uuid().optional(),
      customerId: z.string().uuid().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { page, pageSize, status, search, driverId, customerId } = req.query as unknown as {
      page: number;
      pageSize: number;
      status?: string;
      search?: string;
      driverId?: string;
      customerId?: string;
    };

    const filters = `
      ($1::text IS NULL OR t.status = $1)
      AND ($2::text IS NULL OR t.reference ILIKE '%' || $2 || '%' OR cu.full_name ILIKE '%' || $2 || '%')
      AND ($3::uuid IS NULL OR t.driver_id = $3)
      AND ($4::uuid IS NULL OR t.customer_id = $4)`;

    const params = [status ?? null, search ?? null, driverId ?? null, customerId ?? null];

    const [rows, count] = await Promise.all([
      query(
        `SELECT t.id, t.reference, t.status, t.type, t.pickup_address, t.destination_address,
                t.quoted_fare_minor, t.final_fare_minor, t.payment_status, t.payment_method,
                t.scheduled_pickup_at, t.created_at,
                cu.full_name AS customer_name, du.full_name AS driver_name
           FROM trips t
           JOIN customers c ON c.id = t.customer_id
           JOIN users cu ON cu.id = c.user_id
           LEFT JOIN drivers d ON d.id = t.driver_id
           LEFT JOIN employees e ON e.id = d.employee_id
           LEFT JOIN users du ON du.id = e.user_id
          WHERE ${filters}
          ORDER BY t.created_at DESC
          LIMIT $5 OFFSET $6`,
        [...params, pageSize, (page - 1) * pageSize],
      ),
      queryOne<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM trips t
           JOIN customers c ON c.id = t.customer_id
           JOIN users cu ON cu.id = c.user_id
          WHERE ${filters}`,
        params,
      ),
    ]);

    sendOk(res, paginate(rows, count?.count ?? 0, page, pageSize));
  }),
);

/** Full operational context for one trip — what a support agent opens. */
adminOperationsRouter.get(
  '/trips/:id',
  requirePermission('trip:read'),
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const trip = await queryOne<Record<string, unknown>>(
      `SELECT t.*, cu.full_name AS customer_name, cu.phone AS customer_phone, c.reference AS customer_reference,
              du.full_name AS driver_name, v.plate_number, v.make, v.model
         FROM trips t
         JOIN customers c ON c.id = t.customer_id
         JOIN users cu ON cu.id = c.user_id
         LEFT JOIN drivers d ON d.id = t.driver_id
         LEFT JOIN employees e ON e.id = d.employee_id
         LEFT JOIN users du ON du.id = e.user_id
         LEFT JOIN vehicles v ON v.id = t.vehicle_id
        WHERE t.id = $1`,
      [param(req, 'id')],
    );

    if (!trip) throw notFound('Trip', param(req, 'id'));

    const claims = claimsOf(req);
    const [history, negotiation, payments, assignments] = await Promise.all([
      tripHistory(param(req, 'id')),
      negotiationDetail(param(req, 'id'), hasPermission(claims, 'negotiation:read')),
      query(
        `SELECT id, reference, method, provider, amount_minor, status, paid_at, created_at
           FROM payments WHERE trip_id = $1 ORDER BY created_at DESC`,
        [param(req, 'id')],
      ),
      query(
        `SELECT a.id, a.driver_id, u.full_name AS driver_name, a.reason, a.was_override,
                a.recommendation_score, a.active, a.created_at, a.released_at
           FROM trip_assignments a
           JOIN drivers d ON d.id = a.driver_id
           JOIN employees e ON e.id = d.employee_id
           JOIN users u ON u.id = e.user_id
          WHERE a.trip_id = $1
          ORDER BY a.created_at DESC`,
        [param(req, 'id')],
      ),
    ]);

    // Full customer phone is PII: shown only to roles that need it to make a call.
    if (!hasPermission(claims, 'customer:read_pii')) {
      const { maskPhone } = await import('@transportco/utils');
      trip.customer_phone = maskPhone(trip.customer_phone as string);
    }

    sendOk(res, { trip, history, negotiation, payments, assignments });
  }),
);

adminOperationsRouter.post(
  '/trips/:id/cancel',
  requirePermission('trip:cancel'),
  validateParams(idParams),
  validateBody(cancelTripSchema),
  asyncHandler(async (req, res) => {
    sendOk(
      res,
      await cancelTrip({
        tripId: param(req, 'id'),
        actor: 'admin',
        reason: req.body.reason,
        note: req.body.note,
      }),
    );
  }),
);

// --- Dispatch --------------------------------------------------------------

adminOperationsRouter.get(
  '/dispatch/board',
  requirePermission('trip:read'),
  asyncHandler(async (_req, res) => {
    sendOk(res, await dispatchBoard());
  }),
);

/** The ranked recommendation, with every factor exposed for the dispatcher. */
adminOperationsRouter.get(
  '/dispatch/trips/:id/recommendations',
  requirePermission('trip:assign_driver'),
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    sendOk(res, await recommendDrivers(param(req, 'id')));
  }),
);

adminOperationsRouter.post(
  '/dispatch/trips/:id/assign',
  requirePermission('trip:assign_driver'),
  validateParams(idParams),
  validateBody(assignDriverSchema),
  asyncHandler(async (req, res) => {
    const result = await assignDriver({
      tripId: param(req, 'id'),
      driverId: req.body.driverId,
      reason: req.body.reason,
      note: req.body.note,
      expectedVersion: req.body.expectedVersion,
      assignedByUserId: claimsOf(req).sub,
    });

    sendOk(res, result);
  }),
);

adminOperationsRouter.post(
  '/dispatch/trips/:id/driver-unavailable',
  requirePermission('trip:reassign_driver'),
  validateParams(idParams),
  validateBody(z.object({ reason: z.string().trim().min(3).max(300) })),
  asyncHandler(async (req, res) => {
    sendOk(
      res,
      await markDriverUnavailable({
        tripId: param(req, 'id'),
        reason: req.body.reason,
        actorUserId: claimsOf(req).sub,
      }),
    );
  }),
);

// --- Negotiation console ---------------------------------------------------

adminOperationsRouter.get(
  '/negotiations/queue',
  requirePermission('negotiation:read'),
  asyncHandler(async (_req, res) => {
    const items = await reviewQueue();

    sendOk(
      res,
      items.map((item) => ({
        ...item,
        originalFareLabel: formatMoney(item.originalFareMinor),
        customerOfferLabel: formatMoney(item.customerOfferMinor),
        floorLabel: formatMoney(item.floorMinor),
        companyPositionLabel: formatMoney(item.companyPositionMinor),
      })),
    );
  }),
);

adminOperationsRouter.get(
  '/negotiations/:id',
  requirePermission('negotiation:read'),
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const negotiation = await queryOne<{ trip_id: string }>('SELECT trip_id FROM negotiations WHERE id = $1', [
      param(req, 'id'),
    ]);
    if (!negotiation) throw notFound('Negotiation', param(req, 'id'));

    sendOk(res, await negotiationDetail(negotiation.trip_id, true));
  }),
);

/**
 * Accept, reject or counter.
 *
 * Going below the configured floor requires `negotiation:override_floor`; the
 * permission is checked here and passed into the service, which refuses the
 * override without it and writes an audit entry when it is used.
 */
adminOperationsRouter.post(
  '/negotiations/:id/respond',
  requirePermission('negotiation:respond'),
  validateParams(idParams),
  validateBody(adminNegotiationResponseSchema),
  asyncHandler(async (req, res) => {
    const claims = claimsOf(req);

    const result = await respondAsAdmin({
      negotiationId: param(req, 'id'),
      action: req.body.action,
      counterAmountMinor: req.body.counterAmountMinor,
      overrideFloor: req.body.overrideFloor,
      note: req.body.note,
      canOverrideFloor: hasPermission(claims, 'negotiation:override_floor'),
    });

    sendOk(res, result);
  }),
);

// --- Support & emergency queues --------------------------------------------

adminOperationsRouter.get(
  '/support/tickets',
  requirePermission('support:read'),
  validateQuery(pageQuerySchema.extend({ status: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const { page, pageSize, status } = req.query as unknown as {
      page: number;
      pageSize: number;
      status?: string;
    };

    const rows = await query(
      `SELECT t.id, t.reference, t.category, t.subject, t.status, t.priority, t.created_at,
              u.full_name AS raised_by, tr.reference AS trip_reference
         FROM support_tickets t
         JOIN users u ON u.id = t.raised_by_user_id
         LEFT JOIN trips tr ON tr.id = t.trip_id
        WHERE ($1::text IS NULL OR t.status = $1)
        ORDER BY
          CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          t.created_at ASC
        LIMIT $2 OFFSET $3`,
      [status ?? null, pageSize, (page - 1) * pageSize],
    );

    const count = await queryOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM support_tickets WHERE ($1::text IS NULL OR status = $1)',
      [status ?? null],
    );

    sendOk(res, paginate(rows, count?.count ?? 0, page, pageSize));
  }),
);

adminOperationsRouter.post(
  '/support/tickets/:id/reply',
  requirePermission('support:respond'),
  validateParams(idParams),
  validateBody(
    z.object({
      body: z.string().trim().min(1).max(2000),
      internal: z.boolean().default(false),
      status: z.enum(['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED']).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const claims = claimsOf(req);

    const ticket = await queryOne<{ id: string; raised_by_user_id: string; reference: string }>(
      'SELECT id, raised_by_user_id, reference FROM support_tickets WHERE id = $1',
      [param(req, 'id')],
    );
    if (!ticket) throw notFound('Ticket', param(req, 'id'));

    await query(
      `INSERT INTO support_messages (ticket_id, author_user_id, author_role, body, internal)
       VALUES ($1, $2, 'agent', $3, $4)`,
      [ticket.id, claims.sub, req.body.body, req.body.internal],
    );

    await query(
      `UPDATE support_tickets
          SET status = COALESCE($2, CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END),
              assigned_to_user_id = COALESCE(assigned_to_user_id, $3),
              first_response_at = COALESCE(first_response_at, now()),
              resolved_at = CASE WHEN $2 = 'RESOLVED' THEN now() ELSE resolved_at END
        WHERE id = $1`,
      [ticket.id, req.body.status ?? null, claims.sub],
    );

    // Internal notes are for the team; the customer is told only about replies
    // they can actually read.
    if (!req.body.internal) {
      const { notify } = await import('../../services/notifications');
      await notify({
        userId: ticket.raised_by_user_id,
        event: 'customer.support_update',
        data: { reference: ticket.reference },
      }).catch(() => undefined);
    }

    sendOk(res, { replied: true });
  }),
);

adminOperationsRouter.get(
  '/emergency/incidents',
  requirePermission('emergency:read'),
  asyncHandler(async (_req, res) => {
    sendOk(
      res,
      await query(
        `SELECT i.*, u.full_name AS raised_by_name, t.reference AS trip_reference
           FROM emergency_incidents i
           JOIN users u ON u.id = i.raised_by_user_id
           LEFT JOIN trips t ON t.id = i.trip_id
          ORDER BY
            CASE i.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 WHEN 'responding' THEN 2 ELSE 3 END,
            i.created_at DESC
          LIMIT 100`,
      ),
    );
  }),
);

adminOperationsRouter.post(
  '/emergency/incidents/:id',
  requirePermission('emergency:respond'),
  validateParams(idParams),
  validateBody(
    z.object({
      status: z.enum(['acknowledged', 'responding', 'resolved', 'false_alarm']),
      notes: z.string().trim().max(1000).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const claims = claimsOf(req);

    const updated = await queryOne(
      `UPDATE emergency_incidents
          SET status = $2,
              acknowledged_by_user_id = COALESCE(acknowledged_by_user_id, $3),
              acknowledged_at = COALESCE(acknowledged_at, now()),
              resolved_by_user_id = CASE WHEN $2 IN ('resolved','false_alarm') THEN $3 ELSE resolved_by_user_id END,
              resolved_at = CASE WHEN $2 IN ('resolved','false_alarm') THEN now() ELSE resolved_at END,
              resolution_notes = COALESCE($4, resolution_notes)
        WHERE id = $1
        RETURNING *`,
      [param(req, 'id'), req.body.status, claims.sub, req.body.notes ?? null],
    );

    if (!updated) throw notFound('Incident', param(req, 'id'));
    sendOk(res, updated);
  }),
);
