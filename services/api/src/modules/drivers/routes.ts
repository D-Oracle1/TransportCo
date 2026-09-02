import { Router } from 'express';
import { z } from 'zod';
import {
  cashCollectionSchema,
  driverLocationBatchSchema,
  driverLocationSchema,
  driverStateSchema,
  driverTripActionSchema,
  pageQuerySchema,
} from '@transportco/validation';
import { formatMoney, maskPhone } from '@transportco/utils';
import { asyncHandler, paginate, param, sendOk } from '../../lib/http';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate';
import { authenticate, driverIdOf, requireDriver } from '../../middleware/auth';
import { locationRateLimit } from '../../middleware/rateLimit';
import { idempotency } from '../../middleware/idempotency';
import { query, queryOne } from '../../db/pool';
import { notFound } from '../../lib/errors';
import { recordCashCollection } from '../../services/payments';
import { driverDashboard, performTripAction, recordLocations, setDriverState } from './service';

/**
 * Driver routes.
 *
 * Note what is absent, deliberately: no fare editing, no negotiation, no trip
 * selection, no pricing. A driver executes assigned work. Every route here is
 * scoped to the driver id in the token — a driver cannot even read another
 * driver's trip.
 */
export const driverRouter = Router();

driverRouter.use(authenticate, requireDriver);

const idParams = z.object({ id: z.string().uuid() });

driverRouter.get(
  '/me/dashboard',
  asyncHandler(async (req, res) => {
    sendOk(res, await driverDashboard(driverIdOf(req)));
  }),
);

driverRouter.post(
  '/me/state',
  validateBody(driverStateSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await setDriverState(driverIdOf(req), req.body.state));
  }),
);

/**
 * Single location ping. The app uses an adaptive interval by trip state — 10s
 * while carrying a customer, 45s while merely available — so battery is not
 * consumed reporting a parked car.
 */
driverRouter.post(
  '/me/location',
  locationRateLimit,
  validateBody(driverLocationSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await recordLocations(driverIdOf(req), [req.body]));
  }),
);

/** Batch flush of fixes queued while the driver had no signal. */
driverRouter.post(
  '/me/location/batch',
  locationRateLimit,
  validateBody(driverLocationBatchSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await recordLocations(driverIdOf(req), req.body.points));
  }),
);

driverRouter.get(
  '/me/trips',
  validateQuery(pageQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as { page: number; pageSize: number };
    const driverId = driverIdOf(req);

    const [rows, count] = await Promise.all([
      query(
        `SELECT t.id, t.reference, t.status, t.pickup_address, t.destination_address,
                t.final_fare_minor, t.payment_method, t.payment_status,
                t.scheduled_pickup_at, t.completed_at, t.created_at
           FROM trips t
          WHERE t.driver_id = $1
          ORDER BY t.created_at DESC
          LIMIT $2 OFFSET $3`,
        [driverId, pageSize, (page - 1) * pageSize],
      ),
      queryOne<{ count: number }>('SELECT count(*)::int AS count FROM trips WHERE driver_id = $1', [driverId]),
    ]);

    sendOk(res, paginate(rows, count?.count ?? 0, page, pageSize));
  }),
);

/**
 * The trip as the driver sees it.
 *
 * The customer's full phone number is masked, the quoted fare is absent, and
 * there is no negotiation history — only the agreed fare, read-only.
 */
driverRouter.get(
  '/me/trips/:id',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT t.*, u.full_name AS customer_name, u.phone AS customer_phone
         FROM trips t
         JOIN customers c ON c.id = t.customer_id
         JOIN users u ON u.id = c.user_id
        WHERE t.id = $1 AND t.driver_id = $2`,
      [param(req, 'id'), driverIdOf(req)],
    );

    if (!row) throw notFound('Trip', param(req, 'id'));

    sendOk(res, {
      id: row.id,
      reference: row.reference,
      status: row.status,
      type: row.type,
      customerName: row.customer_name,
      customerMaskedPhone: maskPhone(row.customer_phone as string),
      pickup: {
        latitude: row.pickup_lat,
        longitude: row.pickup_lng,
        address: row.pickup_address,
      },
      destination: {
        latitude: row.destination_lat,
        longitude: row.destination_lng,
        address: row.destination_address,
      },
      passengers: row.passengers,
      specialInstructions: row.special_instructions,
      // Read-only. There is no endpoint through which a driver can change this.
      agreedFareMinor: row.final_fare_minor,
      agreedFareLabel: formatMoney((row.final_fare_minor ?? 0) as number),
      currency: row.currency,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      scheduledPickupAt: (row.scheduled_pickup_at as Date | null)?.toISOString() ?? null,
      distanceMetres: row.distance_metres,
      durationSeconds: row.duration_seconds,
      polyline: row.route_polyline,
    });
  }),
);

/** Advance the trip: en route, arrived, started, completed, no-show. */
driverRouter.post(
  '/me/trips/:id/actions',
  validateParams(idParams),
  idempotency(),
  validateBody(driverTripActionSchema),
  asyncHandler(async (req, res) => {
    const result = await performTripAction({
      driverId: driverIdOf(req),
      tripId: param(req, 'id'),
      action: req.body.action,
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      note: req.body.note,
    });

    sendOk(res, {
      ...result,
      amountLabel: result.amountMinor != null ? formatMoney(result.amountMinor) : null,
    });
  }),
);

/**
 * Cash collected. The amount must equal the locked fare exactly; a shortfall is
 * an operations decision, not something the driver settles at the roadside.
 */
driverRouter.post(
  '/me/trips/:id/cash',
  validateParams(idParams),
  idempotency(),
  validateBody(cashCollectionSchema),
  asyncHandler(async (req, res) => {
    const result = await recordCashCollection({
      tripId: param(req, 'id'),
      driverId: driverIdOf(req),
      amountMinor: req.body.amountMinor,
    });

    sendOk(res, { ...result, recorded: true });
  }),
);
