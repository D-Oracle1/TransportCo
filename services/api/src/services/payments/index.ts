import type {
  InitializePaymentResult,
  NormalisedWebhookEvent,
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  WebhookVerificationInput,
} from '@transportco/types';
import { formatMoney } from '@transportco/utils';
import type { PoolClient } from 'pg';
import { LOCK_NAMESPACE, advisoryLock, query, queryOne, withTransaction } from '../../db/pool';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { env } from '../../config';
import { recordAudit } from '../audit';
import type { PaymentAdapter } from './adapters/types';
import { PaystackAdapter } from './adapters/paystack';
import { FlutterwaveAdapter } from './adapters/flutterwave';
import { CashPaymentHandler } from './adapters/cash';
import { MockPaymentAdapter } from './adapters/mock';

/**
 * PAYMENT SERVICE.
 *
 * The only module that writes to `payments`. Everything else — trips, refunds,
 * outstanding balances — goes through these functions, which is what keeps the
 * following invariants true in one place:
 *
 *   1. A payment is marked succeeded ONLY after server-side verification or a
 *      signature-verified webhook. The customer saying "I paid" is not
 *      evidence, and neither is a client-side redirect.
 *   2. Webhooks are idempotent. Providers redeliver; a redelivery must be a
 *      no-op, never a second credit.
 *   3. The verified amount must match what we asked for. A ₦100 payment against
 *      a ₦7,400 fare is a mismatch, not a settled trip.
 */

const adapters = new Map<PaymentProvider, PaymentAdapter>();

function registerAdapters(): void {
  if (adapters.size > 0) return;

  adapters.set('cash', new CashPaymentHandler());
  adapters.set('paystack', new PaystackAdapter(env.PAYSTACK_SECRET_KEY, env.PAYSTACK_WEBHOOK_SECRET));
  adapters.set(
    'flutterwave',
    new FlutterwaveAdapter(env.FLUTTERWAVE_SECRET_KEY, env.FLUTTERWAVE_WEBHOOK_HASH),
  );

  if (env.NODE_ENV !== 'production') adapters.set('mock', new MockPaymentAdapter());
}

export function getAdapter(provider: PaymentProvider): PaymentAdapter {
  registerAdapters();
  const adapter = adapters.get(provider);
  if (!adapter) {
    throw new AppError({ code: 'provider_unavailable', message: `Unknown payment provider: ${provider}` });
  }
  return adapter;
}

/** Which provider handles a given method, honouring the configured default. */
export function providerForMethod(method: PaymentMethod, requested?: PaymentProvider): PaymentProvider {
  if (method === 'cash') return 'cash';
  if (requested && requested !== 'cash') return requested;
  return env.PAYMENT_PROVIDER_DEFAULT as PaymentProvider;
}

async function nextPaymentReference(client?: PoolClient): Promise<string> {
  const row = await queryOne<{ value: number }>(
    "SELECT nextval('seq_payment_reference')::int AS value",
    [],
    client,
  );
  return `PAY-${String(row?.value ?? Date.now()).padStart(6, '0')}`;
}

export interface CreatePaymentInput {
  customerId: string;
  tripId: string | null;
  amountMinor: number;
  method: PaymentMethod;
  purpose: PaymentPurpose;
  provider?: PaymentProvider;
  customerEmail: string | null;
  customerPhone: string;
  redeemedPoints?: number;
  redeemedValueMinor?: number;
  callbackUrl?: string;
}

export interface CreatedPayment {
  paymentId: string;
  reference: string;
  provider: PaymentProvider;
  status: string;
  amountMinor: number;
  authorizationUrl?: string | null;
  bankTransfer?: InitializePaymentResult['bankTransfer'];
}

export async function createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
  if (input.amountMinor <= 0) {
    throw new AppError({ code: 'validation_failed', message: 'Payment amount must be greater than zero' });
  }

  const provider = providerForMethod(input.method, input.provider);
  const adapter = getAdapter(provider);

  if (!adapter.isConfigured()) {
    throw new AppError({
      code: 'provider_unavailable',
      message: 'That payment method is not available right now. Please choose another.',
    });
  }

  const reference = await nextPaymentReference();

  const payment = await queryOne<{ id: string }>(
    `INSERT INTO payments (
       reference, customer_id, trip_id, purpose, method, provider, amount_minor,
       currency, status, redeemed_points, redeemed_value_minor
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'NGN', 'initialized', $8, $9)
     RETURNING id`,
    [
      reference,
      input.customerId,
      input.tripId,
      input.purpose,
      input.method,
      provider,
      input.amountMinor,
      input.redeemedPoints ?? 0,
      input.redeemedValueMinor ?? 0,
    ],
  );

  const paymentId = payment!.id;

  const result = await adapter.initialize({
    paymentId,
    reference,
    amountMinor: input.amountMinor,
    currency: 'NGN',
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone,
    method: input.method,
    metadata: { tripId: input.tripId, purpose: input.purpose },
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
  });

  await query(
    `UPDATE payments SET status = $2, provider_reference = $3 WHERE id = $1`,
    [paymentId, result.status, result.providerReference],
  );

  await recordTransaction({
    paymentId,
    provider,
    event: 'initialize',
    status: result.status,
    amountMinor: input.amountMinor,
    providerReference: result.providerReference,
    raw: result.raw,
    idempotencyKey: `init:${paymentId}`,
  });

  return {
    paymentId,
    reference,
    provider,
    status: result.status,
    amountMinor: input.amountMinor,
    authorizationUrl: result.authorizationUrl ?? null,
    bankTransfer: result.bankTransfer ?? null,
  };
}

async function recordTransaction(args: {
  paymentId: string;
  provider: PaymentProvider;
  event: string;
  status: string;
  amountMinor: number;
  providerReference: string | null;
  raw: Record<string, unknown>;
  idempotencyKey: string;
  client?: PoolClient;
}): Promise<boolean> {
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO payment_transactions (
       payment_id, provider, event, status, amount_minor, currency, provider_reference, raw_response, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, 'NGN', $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      args.paymentId,
      args.provider,
      args.event,
      args.status,
      args.amountMinor,
      args.providerReference,
      JSON.stringify(args.raw),
      args.idempotencyKey,
    ],
    args.client,
  );

  return inserted !== null;
}

/**
 * Server-side verification. Called from the verify endpoint, from the webhook
 * path, and from the reconciliation worker for payments that never got a
 * webhook (which happens more often than provider documentation suggests).
 */
export async function verifyPayment(paymentId: string): Promise<{ status: string; settled: boolean }> {
  const payment = await queryOne<{
    id: string;
    provider: PaymentProvider;
    provider_reference: string | null;
    amount_minor: number;
    status: string;
    trip_id: string | null;
    customer_id: string;
  }>('SELECT * FROM payments WHERE id = $1', [paymentId]);

  if (!payment) throw new AppError({ code: 'not_found', message: 'Payment not found' });

  if (payment.status === 'succeeded') return { status: 'succeeded', settled: true };
  if (!payment.provider_reference) {
    throw new AppError({ code: 'payment_verification_failed', message: 'This payment was never started' });
  }

  const adapter = getAdapter(payment.provider);
  const result = await adapter.verify(payment.provider_reference);

  // The amount is checked BEFORE the status is trusted. A provider dashboard
  // showing "successful" for the wrong amount is a discrepancy for Finance,
  // not a settled trip.
  if (result.status === 'succeeded' && result.amountMinor !== payment.amount_minor) {
    logger.error(
      { paymentId, expected: payment.amount_minor, received: result.amountMinor },
      'Payment amount mismatch',
    );
    await query(
      `UPDATE payments SET status = 'failed', failure_reason = $2 WHERE id = $1`,
      [paymentId, `amount_mismatch: expected ${payment.amount_minor}, got ${result.amountMinor}`],
    );
    throw new AppError({
      code: 'payment_verification_failed',
      message: 'The amount paid does not match the amount due. Our team has been notified.',
    });
  }

  await applyPaymentResult({
    paymentId,
    provider: payment.provider,
    status: result.status,
    amountMinor: result.amountMinor,
    providerReference: result.providerReference,
    paidAt: result.paidAt,
    raw: result.raw,
    source: 'polling',
    idempotencyKey: `verify:${paymentId}:${result.status}`,
  });

  return { status: result.status, settled: result.status === 'succeeded' };
}

/**
 * Applies a terminal payment outcome. Everything that follows a successful
 * payment — settling the trip, awarding loyalty, clearing an outstanding
 * balance — hangs off this one function, inside one transaction.
 */
async function applyPaymentResult(args: {
  paymentId: string;
  provider: PaymentProvider;
  status: string;
  amountMinor: number;
  providerReference: string | null;
  paidAt: string | null;
  raw: Record<string, unknown>;
  source: 'webhook' | 'polling' | 'manual' | 'driver_confirmation';
  idempotencyKey: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    await advisoryLock(client, LOCK_NAMESPACE.PAYMENT, args.paymentId);

    const fresh = await queryOne<{ status: string; trip_id: string | null; customer_id: string; purpose: string }>(
      'SELECT status, trip_id, customer_id, purpose FROM payments WHERE id = $1 FOR UPDATE',
      [args.paymentId],
      client,
    );

    if (!fresh || fresh.status === 'succeeded') return; // already settled; redelivery

    const isNew = await recordTransaction({ ...args, event: args.source, client });
    if (!isNew) return; // exact event already processed

    if (args.status === 'succeeded') {
      await client.query(
        `UPDATE payments
            SET status = 'succeeded', verified_at = now(), verification_source = $2,
                provider_reference = COALESCE($3, provider_reference),
                paid_at = COALESCE($4::timestamptz, now())
          WHERE id = $1`,
        [args.paymentId, args.source, args.providerReference, args.paidAt],
      );

      const { onPaymentSucceeded } = await import('../../modules/payments/settlement');
      await onPaymentSucceeded(client, {
        paymentId: args.paymentId,
        tripId: fresh.trip_id,
        customerId: fresh.customer_id,
        purpose: fresh.purpose as PaymentPurpose,
        amountMinor: args.amountMinor,
      });
    } else if (args.status === 'failed' || args.status === 'cancelled') {
      await client.query(`UPDATE payments SET status = $2 WHERE id = $1`, [args.paymentId, args.status]);

      if (fresh.trip_id) {
        await client.query(`UPDATE trips SET payment_status = 'failed' WHERE id = $1`, [fresh.trip_id]);
      }
    }
  });
}

/**
 * Webhook entry point.
 *
 * The raw body is required — a signature is computed over bytes, and any JSON
 * round trip would change them. The route mounts a raw body parser for exactly
 * this reason.
 */
export async function handleWebhook(
  provider: PaymentProvider,
  input: WebhookVerificationInput,
): Promise<{ accepted: boolean; reason?: string }> {
  const adapter = getAdapter(provider);
  let event: NormalisedWebhookEvent | null = null;

  try {
    event = adapter.parseWebhook(input);
  } catch (error) {
    logger.warn({ err: error, provider }, 'Malformed webhook payload');
  }

  if (!event) {
    await query(
      `INSERT INTO webhook_events (provider, event_id, event_type, signature_valid, payload)
       VALUES ($1, $2, 'unknown', false, $3)
       ON CONFLICT (provider, event_id) DO NOTHING`,
      [provider, `invalid:${Date.now()}:${Math.random().toString(36).slice(2)}`, JSON.stringify({ raw: input.rawBody.slice(0, 2000) })],
    );

    throw new AppError({
      code: 'webhook_signature_invalid',
      message: 'Webhook signature verification failed',
      logContext: { provider },
    });
  }

  // Record the envelope before doing anything with it. Idempotency is enforced
  // by the unique index: a redelivery inserts nothing and returns here.
  const recorded = await queryOne<{ id: string }>(
    `INSERT INTO webhook_events (provider, event_id, event_type, signature_valid, payload)
     VALUES ($1, $2, $3, true, $4)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id`,
    [provider, event.eventId, event.event, JSON.stringify(event.raw)],
  );

  if (!recorded) {
    logger.info({ provider, eventId: event.eventId }, 'Duplicate webhook ignored');
    return { accepted: true, reason: 'duplicate' };
  }

  const payment = await queryOne<{ id: string; amount_minor: number }>(
    'SELECT id, amount_minor FROM payments WHERE reference = $1 OR provider_reference = $1',
    [event.reference],
  );

  if (!payment) {
    await query(
      `UPDATE webhook_events SET processed = true, processed_at = now(), processing_error = $2 WHERE id = $1`,
      [recorded.id, 'no_matching_payment'],
    );
    logger.warn({ provider, reference: event.reference }, 'Webhook for an unknown payment');
    return { accepted: true, reason: 'unknown_payment' };
  }

  if (event.status === 'succeeded' && event.amountMinor !== payment.amount_minor) {
    await query(
      `UPDATE webhook_events SET processed = true, processed_at = now(), processing_error = $2 WHERE id = $1`,
      [recorded.id, 'amount_mismatch'],
    );
    logger.error(
      { provider, paymentId: payment.id, expected: payment.amount_minor, received: event.amountMinor },
      'Webhook amount mismatch',
    );
    return { accepted: true, reason: 'amount_mismatch' };
  }

  await applyPaymentResult({
    paymentId: payment.id,
    provider,
    status: event.status,
    amountMinor: event.amountMinor,
    providerReference: event.providerReference,
    paidAt: event.paidAt,
    raw: event.raw,
    source: 'webhook',
    idempotencyKey: event.eventId,
  });

  await query(
    `UPDATE webhook_events SET processed = true, processed_at = now() WHERE id = $1`,
    [recorded.id],
  );

  return { accepted: true };
}

/**
 * Cash collection, confirmed by the assigned driver.
 *
 * The amount must equal the locked fare exactly. This is the guard against both
 * an honest mistake and the "driver pockets the difference" failure mode: a
 * shortfall is an operations decision, not something the driver can settle by
 * typing a smaller number.
 */
export async function recordCashCollection(args: {
  tripId: string;
  driverId: string;
  amountMinor: number;
}): Promise<{ paymentId: string }> {
  return withTransaction(async (client) => {
    await advisoryLock(client, LOCK_NAMESPACE.TRIP, args.tripId);

    const trip = await queryOne<{
      id: string;
      customer_id: string;
      driver_id: string | null;
      final_fare_minor: number | null;
      payment_method: string | null;
      payment_status: string;
      status: string;
    }>('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [args.tripId], client);

    if (!trip) throw new AppError({ code: 'not_found', message: 'Trip not found' });

    if (trip.driver_id !== args.driverId) {
      throw new AppError({
        code: 'forbidden',
        message: 'Only the assigned driver can confirm cash collection',
      });
    }

    if (trip.payment_status === 'paid') {
      const existing = await queryOne<{ id: string }>(
        "SELECT id FROM payments WHERE trip_id = $1 AND status = 'succeeded' AND purpose = 'trip_fare'",
        [args.tripId],
        client,
      );
      return { paymentId: existing!.id };
    }

    const due = trip.final_fare_minor;
    if (due == null) {
      throw new AppError({ code: 'conflict', message: 'This trip has no agreed fare' });
    }

    if (args.amountMinor !== due) {
      throw new AppError({
        code: 'validation_failed',
        message: `Cash collected must equal the agreed fare of ${formatMoney(due)}. Report a shortfall to operations instead.`,
        logContext: { tripId: args.tripId, expected: due, reported: args.amountMinor },
      });
    }

    const reference = await nextPaymentReference(client);

    const payment = await queryOne<{ id: string }>(
      `INSERT INTO payments (
         reference, customer_id, trip_id, purpose, method, provider, amount_minor, currency,
         status, verified_at, verification_source, collected_by_driver_id, paid_at
       ) VALUES ($1, $2, $3, 'trip_fare', 'cash', 'cash', $4, 'NGN',
                 'succeeded', now(), 'driver_confirmation', $5, now())
       RETURNING id`,
      [reference, trip.customer_id, trip.id, due, args.driverId],
      client,
    );

    await recordTransaction({
      paymentId: payment!.id,
      provider: 'cash',
      event: 'cash_collected',
      status: 'succeeded',
      amountMinor: due,
      providerReference: reference,
      raw: { driverId: args.driverId, tripId: args.tripId },
      idempotencyKey: `cash:${args.tripId}`,
      client,
    });

    const { onPaymentSucceeded } = await import('../../modules/payments/settlement');
    await onPaymentSucceeded(client, {
      paymentId: payment!.id,
      tripId: trip.id,
      customerId: trip.customer_id,
      purpose: 'trip_fare',
      amountMinor: due,
    });

    await recordAudit(
      {
        action: 'payment.reconciled',
        resourceType: 'payment',
        resourceId: payment!.id,
        newValue: { method: 'cash', amountMinor: due, tripId: args.tripId },
        actorType: 'driver',
      },
      client,
    );

    return { paymentId: payment!.id };
  });
}
