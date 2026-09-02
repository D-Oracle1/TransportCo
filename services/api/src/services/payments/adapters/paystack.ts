import { createHmac } from 'node:crypto';
import { safeEqual } from '@transportco/utils/secure';
import type {
  InitializePaymentRequest,
  InitializePaymentResult,
  NormalisedWebhookEvent,
  PaymentStatus,
  VerifyPaymentResult,
  WebhookVerificationInput,
} from '@transportco/types';
import type { PaymentAdapter } from './types';
import { AppError } from '../../../lib/errors';
import { logger } from '../../../lib/logger';

/**
 * Paystack adapter.
 *
 * Paystack denominates NGN in kobo, which matches this platform's internal
 * representation exactly — no conversion, and therefore no rounding bug at the
 * boundary.
 */
const API_BASE = 'https://api.paystack.co';

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

interface PaystackTransaction {
  id: number;
  reference: string;
  amount: number;
  currency: string;
  status: string;
  paid_at: string | null;
  authorization_url?: string;
  access_code?: string;
}

function mapStatus(paystackStatus: string): PaymentStatus {
  switch (paystackStatus) {
    case 'success':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'abandoned':
      return 'cancelled';
    case 'reversed':
      return 'refunded';
    case 'ongoing':
    case 'pending':
    case 'processing':
      return 'processing';
    default:
      return 'pending';
  }
}

export class PaystackAdapter implements PaymentAdapter {
  readonly provider = 'paystack' as const;

  constructor(
    private readonly secretKey: string | undefined,
    private readonly webhookSecret: string | undefined,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.secretKey);
  }

  private async call<T>(path: string, init?: RequestInit): Promise<PaystackEnvelope<T>> {
    if (!this.secretKey) {
      throw new AppError({ code: 'provider_unavailable', message: 'Card payments are not available' });
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

    const body = (await response.json()) as PaystackEnvelope<T>;

    if (!response.ok || !body.status) {
      logger.warn({ path, status: response.status, message: body.message }, 'Paystack call failed');
      throw new AppError({
        code: 'payment_failed',
        message: body.message || 'The payment provider rejected this request',
        logContext: { provider: 'paystack', path },
      });
    }

    return body;
  }

  async initialize(request: InitializePaymentRequest): Promise<InitializePaymentResult> {
    const body = await this.call<PaystackTransaction>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        // Paystack requires an email; a synthetic address keyed to the payment
        // keeps customers who signed up with only a phone number workable.
        email: request.customerEmail ?? `${request.reference}@customers.transportco.example`,
        amount: request.amountMinor,
        currency: request.currency,
        reference: request.reference,
        channels: request.method === 'bank_transfer' ? ['bank_transfer'] : ['card', 'bank', 'ussd'],
        metadata: { ...request.metadata, paymentId: request.paymentId },
        ...(request.callbackUrl ? { callback_url: request.callbackUrl } : {}),
      }),
    });

    return {
      provider: 'paystack',
      providerReference: body.data.reference,
      status: 'pending',
      authorizationUrl: body.data.authorization_url ?? null,
      bankTransfer: null,
      raw: body as unknown as Record<string, unknown>,
    };
  }

  async verify(providerReference: string): Promise<VerifyPaymentResult> {
    const body = await this.call<PaystackTransaction>(
      `/transaction/verify/${encodeURIComponent(providerReference)}`,
    );

    return {
      provider: 'paystack',
      providerReference: body.data.reference,
      status: mapStatus(body.data.status),
      amountMinor: body.data.amount,
      currency: body.data.currency as 'NGN',
      paidAt: body.data.paid_at,
      raw: body as unknown as Record<string, unknown>,
    };
  }

  parseWebhook(input: WebhookVerificationInput): NormalisedWebhookEvent | null {
    if (!this.webhookSecret) return null;

    const signature = input.headers['x-paystack-signature'];
    if (typeof signature !== 'string') return null;

    // Paystack signs the raw body with the SECRET KEY using SHA-512.
    const expected = createHmac('sha512', this.webhookSecret).update(input.rawBody).digest('hex');
    if (!safeEqual(expected, signature)) return null;

    const payload = JSON.parse(input.rawBody) as {
      event: string;
      data: PaystackTransaction;
    };

    return {
      provider: 'paystack',
      // Paystack does not send a dedicated event id, so the transaction id plus
      // the event name gives a stable idempotency key across redeliveries.
      eventId: `paystack:${payload.data.id}:${payload.event}`,
      event: payload.event,
      reference: payload.data.reference,
      providerReference: payload.data.reference,
      status: mapStatus(payload.data.status),
      amountMinor: payload.data.amount,
      currency: (payload.data.currency ?? 'NGN') as 'NGN',
      paidAt: payload.data.paid_at,
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  async refund(args: { providerReference: string; amountMinor: number; reason: string }): Promise<{
    providerReference: string;
    status: 'processing' | 'succeeded' | 'failed';
    raw: Record<string, unknown>;
  }> {
    const body = await this.call<{ id: number; status: string }>('/refund', {
      method: 'POST',
      body: JSON.stringify({
        transaction: args.providerReference,
        amount: args.amountMinor,
        merchant_note: args.reason,
      }),
    });

    return {
      providerReference: String(body.data.id),
      status: body.data.status === 'processed' ? 'succeeded' : 'processing',
      raw: body as unknown as Record<string, unknown>,
    };
  }
}
