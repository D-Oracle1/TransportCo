import { Router } from 'express';
import { z } from 'zod';
import {
  acceptFareSchema,
  cancelTripSchema,
  createTripSchema,
  customerOfferSchema,
  fareEstimateSchema,
  pageQuerySchema,
  reviewSchema,
} from '@transportco/validation';
import { formatMoney } from '@transportco/utils';
import { asyncHandler, paginate, param, sendCreated, sendOk } from '../../lib/http';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate';
import { authenticate, customerIdOf, requireCustomer } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { query, queryOne } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import { customerStatusLabel } from '../../domain/trip/stateMachine';
import { createQuote } from '../pricing/service';
import { acceptCompanyOffer, negotiationDetail, submitCustomerOffer } from '../negotiation/service';
import { cancelTrip, createTrip, previewCancellation } from './service';
import { tripHistory } from './repository';

/**
 * Customer trip routes.
 *
 * Everything here is scoped to the authenticated customer. Ownership is checked
 * against the token's customer id on every read — a trip id is not a capability.
 */
export const tripRouter = Router();

tripRouter.use(authenticate, requireCustomer);

const idParams = z.object({ id: z.string().uuid() });

/**
 * Price a trip. Returns a quote id; the fare itself is never accepted back from
 * the client.
 */
tripRouter.post(
  '/estimate',
  rateLimit({ bucket: 'estimate', max: 60, windowMs: 60_000 }),
  validateBody(fareEstimateSchema),
  asyncHandler(async (req, res) => {
    const result = await createQuote({
      customerId: customerIdOf(req),
      pickup: req.body.pickup,
      destination: req.body.destination,
      passengers: req.body.passengers,
      scheduledFor: req.body.scheduledFor ? new Date(req.body.scheduledFor) : null,
    });

    sendOk(res, result.customerView);
  }),
);

/** Create a trip from a quote. Idempotent: a retry on a flaky network is safe. */
tripRouter.post(
  '/',
  idempotency(),
  validateBody(createTripSchema),
  asyncHandler(async (req, res) => {
    const trip = await createTrip({
      customerId: customerIdOf(req),
      quoteId: req.body.quoteId,
      paymentMethod: req.body.paymentMethod,
      specialInstructions: req.body.specialInstructions,
    });

    sendCreated(res, {
      ...trip,
      fareLabel: formatMoney(trip.quotedFareMinor),
      statusLabel: customerStatusLabel('FARE_CALCULATED'),
    });
  }),
);

tripRouter.get(
  '/',
  validateQuery(pageQuerySchema.extend({ status: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const { page, pageSize, status } = req.query as unknown as {
      page: number;
      pageSize: number;
      status?: string;
    };
    const customerId = customerIdOf(req);
    const offset = (page - 1) * pageSize;

    const [rows, count] = await Promise.all([
      query(
        `SELECT t.id, t.reference, t.status, t.type, t.pickup_address, t.destination_address,
                t.quoted_fare_minor, t.final_fare_minor, t.currency, t.payment_status, t.payment_method,
                t.scheduled_pickup_at, t.created_at, t.completed_at,
                u.full_name AS driver_name
           FROM trips t
           LEFT JOIN drivers d ON d.id = t.driver_id
           LEFT JOIN employees e ON e.id = d.employee_id
           LEFT JOIN users u ON u.id = e.user_id
          WHERE t.customer_id = $1 AND ($2::text IS NULL OR t.status = $2)
          ORDER BY t.created_at DESC
          LIMIT $3 OFFSET $4`,
        [customerId, status ?? null, pageSize, offset],
      ),
      queryOne<{ count: number }>(
        'SELECT count(*)::int AS count FROM trips WHERE customer_id = $1 AND ($2::text IS NULL OR status = $2)',
        [customerId, status ?? null],
      ),
    ]);

    sendOk(
      res,
      paginate(
        rows.map((row) => ({
          ...row,
          statusLabel: customerStatusLabel(row.status as never),
          fareLabel: formatMoney((row.final_fare_minor ?? row.quoted_fare_minor) as number),
        })),
        count?.count ?? 0,
        page,
        pageSize,
      ),
    );
  }),
);

/** The active trip the app opens onto. */
tripRouter.get(
  '/active',
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `SELECT t.*, u.full_name AS driver_name, e.photo_url AS driver_photo, d.rating AS driver_rating,
              d.last_latitude AS driver_lat, d.last_longitude AS driver_lng,
              v.plate_number, v.make, v.model, v.color
         FROM trips t
         LEFT JOIN drivers d ON d.id = t.driver_id
         LEFT JOIN employees e ON e.id = d.employee_id
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN vehicles v ON v.id = t.vehicle_id
        WHERE t.customer_id = $1
          AND t.status NOT IN ('COMPLETED','CANCELLED','EXPIRED')
        ORDER BY t.created_at DESC
        LIMIT 1`,
      [customerIdOf(req)],
    );

    sendOk(res, row ? serialiseCustomerTrip(row) : null);
  }),
);

tripRouter.get(
  '/:id',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `SELECT t.*, u.full_name AS driver_name, e.photo_url AS driver_photo, d.rating AS driver_rating,
              d.last_latitude AS driver_lat, d.last_longitude AS driver_lng,
              v.plate_number, v.make, v.model, v.color
         FROM trips t
         LEFT JOIN drivers d ON d.id = t.driver_id
         LEFT JOIN employees e ON e.id = d.employee_id
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN vehicles v ON v.id = t.vehicle_id
        WHERE t.id = $1 AND t.customer_id = $2`,
      [param(req, 'id'), customerIdOf(req)],
    );

    if (!row) throw notFound('Trip', param(req, 'id'));
    sendOk(res, serialiseCustomerTrip(row));
  }),
);

tripRouter.get(
  '/:id/timeline',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    await assertOwnership(param(req, 'id'), customerIdOf(req));
    const history = await tripHistory(param(req, 'id'));

    sendOk(
      res,
      history.map((entry) => ({
        status: entry.to_status,
        label: customerStatusLabel(entry.to_status),
        at: entry.created_at.toISOString(),
      })),
    );
  }),
);

// --- Negotiation -----------------------------------------------------------

/** The customer's view of their negotiation. The floor is never included. */
tripRouter.get(
  '/:id/negotiation',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    await assertOwnership(param(req, 'id'), customerIdOf(req));
    const detail = await negotiationDetail(param(req, 'id'), false);
    sendOk(res, detail);
  }),
);

tripRouter.post(
  '/:id/negotiate',
  validateParams(idParams),
  rateLimit({ bucket: 'negotiate', max: 20, windowMs: 60_000 }),
  validateBody(customerOfferSchema),
  asyncHandler(async (req, res) => {
    const result = await submitCustomerOffer({
      tripId: param(req, 'id'),
      customerId: customerIdOf(req),
      amountMinor: req.body.amountMinor,
      message: req.body.message,
    });

    sendOk(res, {
      ...result,
      counterLabel:
        result.counterAmountMinor != null ? formatMoney(result.counterAmountMinor) : undefined,
      finalFareLabel: result.finalFareMinor != null ? formatMoney(result.finalFareMinor) : undefined,
    });
  }),
);

tripRouter.post(
  '/:id/accept-fare',
  validateParams(idParams),
  validateBody(acceptFareSchema.partial()),
  asyncHandler(async (req, res) => {
    const result = await acceptCompanyOffer({
      tripId: param(req, 'id'),
      customerId: customerIdOf(req),
      offerId: (req.body as { offerId?: string }).offerId ?? null,
    });

    sendOk(res, {
      finalFareMinor: result.finalFareMinor,
      finalFareLabel: formatMoney(result.finalFareMinor),
      status: 'FARE_LOCKED',
      statusLabel: customerStatusLabel('FARE_LOCKED'),
    });
  }),
);

// --- Cancellation ----------------------------------------------------------

/** What cancelling would cost, shown before the customer confirms. */
tripRouter.get(
  '/:id/cancellation-preview',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const preview = await previewCancellation(param(req, 'id'), customerIdOf(req));
    sendOk(res, { ...preview, feeLabel: formatMoney(preview.feeMinor) });
  }),
);

tripRouter.post(
  '/:id/cancel',
  validateParams(idParams),
  validateBody(cancelTripSchema),
  asyncHandler(async (req, res) => {
    const result = await cancelTrip({
      tripId: param(req, 'id'),
      actor: 'customer',
      customerId: customerIdOf(req),
      reason: req.body.reason,
      note: req.body.note,
    });

    sendOk(res, { ...result, feeLabel: formatMoney(result.feeMinor) });
  }),
);

// --- Rating ----------------------------------------------------------------

tripRouter.post(
  '/:id/review',
  validateParams(idParams),
  validateBody(reviewSchema),
  asyncHandler(async (req, res) => {
    const customerId = customerIdOf(req);
    const trip = await queryOne<{ id: string; driver_id: string | null; status: string }>(
      'SELECT id, driver_id, status FROM trips WHERE id = $1 AND customer_id = $2',
      [param(req, 'id'), customerId],
    );

    if (!trip) throw notFound('Trip', param(req, 'id'));
    if (!trip.driver_id) {
      throw new AppError({ code: 'conflict', message: 'This trip had no driver to rate' });
    }

    // Only a trip that actually ran produces a rating that counts towards a
    // driver's average — otherwise ratings become a weapon in fare disputes.
    const rateable = ['PAYMENT_COMPLETED', 'REVIEW_PENDING', 'COMPLETED'];
    if (!rateable.includes(trip.status)) {
      throw new AppError({ code: 'conflict', message: 'You can rate a trip once it is complete' });
    }

    await query(
      `INSERT INTO reviews (trip_id, customer_id, driver_id, driver_rating, service_rating, comment, tags, verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (trip_id) DO UPDATE
         SET driver_rating = EXCLUDED.driver_rating,
             service_rating = EXCLUDED.service_rating,
             comment = EXCLUDED.comment`,
      [
        trip.id,
        customerId,
        trip.driver_id,
        req.body.driverRating,
        req.body.serviceRating ?? null,
        req.body.comment ?? null,
        JSON.stringify(req.body.tags ?? []),
      ],
    );

    // The driver average is recomputed from verified reviews rather than
    // incremented, so a corrected rating cannot leave a stale average behind.
    await query(
      `UPDATE drivers d
          SET rating = sub.avg_rating, rating_count = sub.count
         FROM (SELECT driver_id, ROUND(AVG(driver_rating)::numeric, 2) AS avg_rating, count(*)::int AS count
                 FROM reviews WHERE driver_id = $1 AND verified GROUP BY driver_id) sub
        WHERE d.id = sub.driver_id`,
      [trip.driver_id],
    );

    if (trip.status === 'REVIEW_PENDING') {
      const { withTransaction } = await import('../../db/pool');
      const { lockTrip, transitionTrip } = await import('./repository');
      await withTransaction(async (client) => {
        const locked = await lockTrip(trip.id, client);
        await transitionTrip(client, locked, 'COMPLETED', 'customer', { reason: 'Customer rated the trip' });
      });
    }

    sendOk(res, { recorded: true });
  }),
);

async function assertOwnership(tripId: string, customerId: string): Promise<void> {
  const row = await queryOne<{ id: string }>('SELECT id FROM trips WHERE id = $1 AND customer_id = $2', [
    tripId,
    customerId,
  ]);
  if (!row) throw notFound('Trip', tripId);
}

/**
 * Customer projection. Assembled explicitly rather than by spreading the row,
 * so an internal column added later cannot leak by default.
 */
function serialiseCustomerTrip(row: Record<string, unknown>) {
  const status = row.status as Parameters<typeof customerStatusLabel>[0];
  const finalFare = row.final_fare_minor as number | null;
  const quotedFare = row.quoted_fare_minor as number;

  return {
    id: row.id,
    reference: row.reference,
    status,
    statusLabel: customerStatusLabel(status),
    type: row.type,
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
    distanceMetres: row.distance_metres,
    durationSeconds: row.duration_seconds,
    polyline: row.route_polyline,
    currency: row.currency,
    quotedFareMinor: quotedFare,
    finalFareMinor: finalFare,
    fareLabel: formatMoney(finalFare ?? quotedFare),
    fareLocked: row.fare_locked_at !== null,
    scheduledPickupAt: (row.scheduled_pickup_at as Date | null)?.toISOString() ?? null,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    driver: row.driver_name
      ? {
          name: row.driver_name,
          photoUrl: row.driver_photo,
          rating: row.driver_rating === null ? null : Number(row.driver_rating),
          location:
            row.driver_lat !== null && row.driver_lng !== null
              ? { latitude: row.driver_lat, longitude: row.driver_lng }
              : null,
          vehicle: row.plate_number
            ? {
                plateNumber: row.plate_number,
                make: row.make,
                model: row.model,
                color: row.color,
              }
            : null,
        }
      : null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
