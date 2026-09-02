import { Router, raw } from 'express';
import { z } from 'zod';
import { initializePaymentSchema, verifyPaymentSchema } from '@transportco/validation';
import { formatMoney } from '@transportco/utils';
import type { PaymentProvider } from '@transportco/types';
import { asyncHandler, param, sendOk } from '../../lib/http';
import { validateBody } from '../../middleware/validate';
import { authenticate, customerIdOf, requireCustomer } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';
import { query, queryOne } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import { createPayment, handleWebhook, verifyPayment } from '../../services/payments';
import { quoteRedemption } from '../../domain/loyalty/rules';
import { getPricingRuleSetById } from '../pricing/repository';
import { env } from '../../config';
import { logger } from '../../lib/logger';

/**
 * Payment routes.
 *
 * The webhook router is mounted separately in `app.ts` BEFORE the JSON body
 * parser, because signature verification runs over the raw bytes. Parsing and
 * re-serialising JSON changes those bytes and every signature check would fail.
 */
export const paymentRouter = Router();

paymentRouter.use(authenticate, requireCustomer);

/**
 * Start a payment.
 *
 * The AMOUNT IS NEVER TAKEN FROM THE CLIENT. It is read from the trip's locked
 * fare, less any loyalty redemption the server itself calculates and caps.
 */
paymentRouter.post(
  '/initialize',
  idempotency(),
  validateBody(initializePaymentSchema),
  asyncHandler(async (req, res) => {
    const customerId = customerIdOf(req);
    const body = req.body as {
      tripId?: string;
      purpose: 'trip_fare' | 'cancellation_fee' | 'no_show_fee' | 'outstanding_balance';
      method: 'card' | 'bank_transfer' | 'cash';
      provider?: PaymentProvider;
      redeemPoints?: number;
    };

    const contact = await queryOne<{ email: string | null; phone: string }>(
      'SELECT u.email, u.phone FROM customers c JOIN users u ON u.id = c.user_id WHERE c.id = $1',
      [customerId],
    );
    if (!contact) throw notFound('Customer', customerId);

    let amountMinor: number;
    let redeemedPoints = 0;
    let redeemedValueMinor = 0;

    if (body.purpose === 'trip_fare') {
      if (!body.tripId) {
        throw new AppError({ code: 'validation_failed', message: 'A trip is required for a fare payment' });
      }

      const trip = await queryOne<{
        id: string;
        final_fare_minor: number | null;
        payment_status: string;
        pricing_rule_set_id: string;
      }>(
        'SELECT id, final_fare_minor, payment_status, pricing_rule_set_id FROM trips WHERE id = $1 AND customer_id = $2',
        [body.tripId, customerId],
      );

      if (!trip) throw notFound('Trip', body.tripId);
      if (trip.payment_status === 'paid') {
        throw new AppError({ code: 'conflict', message: 'This trip is already paid' });
      }
      if (trip.final_fare_minor == null) {
        throw new AppError({ code: 'conflict', message: 'This trip has no agreed fare yet' });
      }

      amountMinor = trip.final_fare_minor;

      if (body.redeemPoints && body.redeemPoints > 0) {
        const rules = await getPricingRuleSetById(trip.pricing_rule_set_id);
        const account = await queryOne<{ balance_points: number }>(
          'SELECT balance_points FROM loyalty_accounts WHERE customer_id = $1',
          [customerId],
        );

        const redemption = quoteRedemption({
          requestedPoints: body.redeemPoints,
          balancePoints: account?.balance_points ?? 0,
          fareMinor: amountMinor,
          policy: rules.loyalty,
        });

        redeemedPoints = redemption.points;
        redeemedValueMinor = redemption.valueMinor;
        amountMinor = redemption.payableMinor;
      }
    } else {
      const outstanding = await queryOne<{ total: number }>(
        `SELECT COALESCE(SUM(amount_minor - settled_amount_minor), 0)::bigint AS total
           FROM outstanding_balances
          WHERE customer_id = $1 AND status IN ('outstanding','partially_settled')`,
        [customerId],
      );

      amountMinor = Number(outstanding?.total ?? 0);
      if (amountMinor <= 0) {
        throw new AppError({ code: 'conflict', message: 'You have nothing outstanding' });
      }
    }

    const payment = await createPayment({
      customerId,
      tripId: body.tripId ?? null,
      amountMinor,
      method: body.method,
      purpose: body.purpose,
      provider: body.provider,
      customerEmail: contact.email,
      customerPhone: contact.phone,
      redeemedPoints,
      redeemedValueMinor,
      callbackUrl: `${env.API_BASE_URL}/payments/callback`,
    });

    // Points are burned only once the payment actually succeeds — that happens
    // in settlement, not here, so an abandoned checkout costs the customer
    // nothing.
    sendOk(res, {
      ...payment,
      amountLabel: formatMoney(payment.amountMinor),
      redeemedPoints,
      redeemedValueLabel: formatMoney(redeemedValueMinor),
    });
  }),
);

paymentRouter.post(
  '/verify',
  validateBody(verifyPaymentSchema),
  asyncHandler(async (req, res) => {
    const payment = await queryOne<{ customer_id: string }>('SELECT customer_id FROM payments WHERE id = $1', [
      req.body.paymentId,
    ]);

    if (!payment) throw notFound('Payment', req.body.paymentId);
    if (payment.customer_id !== customerIdOf(req)) {
      throw new AppError({ code: 'forbidden', message: 'That payment belongs to another account' });
    }

    sendOk(res, await verifyPayment(req.body.paymentId));
  }),
);

paymentRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    sendOk(
      res,
      await query(
        `SELECT p.id, p.reference, p.purpose, p.method, p.provider, p.amount_minor, p.status,
                p.paid_at, p.created_at, t.reference AS trip_reference
           FROM payments p
           LEFT JOIN trips t ON t.id = p.trip_id
          WHERE p.customer_id = $1
          ORDER BY p.created_at DESC
          LIMIT 50`,
        [customerIdOf(req)],
      ),
    );
  }),
);

/**
 * Webhook router — mounted with a RAW body parser and NO authentication.
 *
 * Authentication here is the provider signature, verified in the adapter. An
 * unsigned or badly signed payload is recorded and rejected; a replayed one is
 * deduplicated by event id. Both matter: this endpoint is how money becomes
 * true in the system.
 */
export const webhookRouter = Router();

webhookRouter.post(
  '/:provider',
  raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const parsed = z.enum(['paystack', 'flutterwave', 'mock']).safeParse(param(req, 'provider'));
    if (!parsed.success) throw notFound('Payment provider', param(req, 'provider'));

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);

    const result = await handleWebhook(parsed.data, { rawBody, headers: req.headers });

    logger.info({ provider: parsed.data, result }, 'Webhook processed');

    // Providers retry anything that is not a 2xx. Once the event is safely
    // recorded, acknowledge — even for an event we chose not to act on.
    res.status(200).json({ received: true });
  }),
);

/** Redirect landing after hosted checkout. Purely informational. */
export const paymentCallbackRouter = Router();

paymentCallbackRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const reference = String(req.query.reference ?? req.query.tx_ref ?? '');

    if (reference) {
      const payment = await queryOne<{ id: string }>(
        'SELECT id FROM payments WHERE reference = $1 OR provider_reference = $1',
        [reference],
      );

      // Verify server-side rather than trusting the redirect: a redirect is a
      // browser navigation the customer could have typed themselves.
      if (payment) {
        await verifyPayment(payment.id).catch((error: unknown) => {
          logger.warn({ err: error, reference }, 'Callback verification failed');
        });
      }
    }

    res.status(200).send(
      '<html><body style="font-family:system-ui;padding:40px;text-align:center">' +
        '<h2>Payment received</h2><p>You can return to the TransportCo app.</p></body></html>',
    );
  }),
);
