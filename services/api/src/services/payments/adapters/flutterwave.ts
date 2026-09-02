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
 * Flutterwave adapter.
 *
 * Unlike Paystack, Flutterwave denominates in MAJOR units (naira, not kobo).
 * Every amount is converted at this boundary and nowhere else — that conversion
 * is the single most likely place for a 100x error, so it lives in two clearly
 * named helpers rather than being inlined at each call site.
 */
const API_BASE = 'https://api.flutterwave.com/v3';

const toMajor = (minor: number): number => minor / 100;
const toMinor = (major: number): number => Math.round(major * 100);

interface FlutterwaveEnvelope<T> {
  status: string;
  message: string;
  data: T;
}

interface FlutterwaveTransaction {
  id: number;
  tx_ref: string;
  flw_ref?: string;
  amount: number;
  currency: string;
  status: string;
  created_at?: string;
  charged_amount?: number;
}

function mapStatus(status: string): PaymentStatus {
  switch (status?.toLowerCase()) {
    case 'successful':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
      return 'pending';
    default:
      return 'processing';
  }
}

export class FlutterwaveAdapter implements PaymentAdapter {
  readonly provider = 'flutterwave' as const;

  constructor(
    private readonly secretKey: string | undefined,
    private readonly webhookHash: string | undefined,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.secretKey);
  }

  private async call<T>(path: string, init?: RequestInit): Promise<FlutterwaveEnvelope<T>> {
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

    const body = (await response.json()) as FlutterwaveEnvelope<T>;

    if (!response.ok || body.status !== 'success') {
      logger.warn({ path, status: response.status, message: body.message }, 'Flutterwave call failed');
      throw new AppError({
        code: 'payment_failed',
        message: body.message || 'The payment provider rejected this request',
        logContext: { provider: 'flutterwave', path },
      });
    }

    return body;
  }

  async initialize(request: InitializePaymentRequest): Promise<InitializePaymentResult> {
    const body = await this.call<{ link: string }>('/payments', {
      method: 'POST',
      body: JSON.stringify({
        tx_ref: request.reference,
        amount: toMajor(request.amountMinor),
        currency: request.currency,
        payment_options: request.method === 'bank_transfer' ? 'banktransfer' : 'card,banktransfer,ussd',
        customer: {
          email: request.customerEmail ?? `${request.reference}@customers.transportco.example`,
          phonenumber: request.customerPhone,
        },
        meta: { ...request.metadata, paymentId: request.paymentId },
        ...(request.callbackUrl ? { redirect_url: request.callbackUrl } : {}),
      }),
    });

    return {
      provider: 'flutterwave',
      providerReference: request.reference,
      status: 'pending',
      authorizationUrl: body.data.link,
      bankTransfer: null,
      raw: body as unknown as Record<string, unknown>,
    };
  }

  async verify(providerReference: string): Promise<VerifyPaymentResult> {
    const body = await this.call<FlutterwaveTransaction>(
      `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(providerReference)}`,
    );

    return {
      provider: 'flutterwave',
      providerReference: body.data.flw_ref ?? body.data.tx_ref,
      status: mapStatus(body.data.status),
      amountMinor: toMinor(body.data.charged_amount ?? body.data.amount),
      currency: (body.data.currency ?? 'NGN') as 'NGN',
      paidAt: body.data.created_at ?? null,
      raw: body as unknown as Record<string, unknown>,
    };
  }

  parseWebhook(input: WebhookVerificationInput): NormalisedWebhookEvent | null {
    if (!this.webhookHash) return null;

    // Flutterwave sends a shared secret rather than a signature. It still gets
    // a constant-time comparison — a timing oracle on a shared secret is a
    // slower but perfectly real attack.
    const provided = input.headers['verif-hash'];
    if (typeof provided !== 'string' || !safeEqual(this.webhookHash, provided)) return null;

    const payload = JSON.parse(input.rawBody) as {
      event?: string;
      data: FlutterwaveTransaction;
    };

    return {
      provider: 'flutterwave',
      eventId: `flutterwave:${payload.data.id}:${payload.event ?? 'charge'}`,
      event: payload.event ?? 'charge.completed',
      reference: payload.data.tx_ref,
      providerReference: payload.data.flw_ref ?? payload.data.tx_ref,
      status: mapStatus(payload.data.status),
      amountMinor: toMinor(payload.data.charged_amount ?? payload.data.amount),
      currency: (payload.data.currency ?? 'NGN') as 'NGN',
      paidAt: payload.data.created_at ?? null,
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  async refund(args: { providerReference: string; amountMinor: number }): Promise<{
    providerReference: string;
    status: 'processing' | 'succeeded' | 'failed';
    raw: Record<string, unknown>;
  }> {
    const body = await this.call<{ id: number; status: string }>(
      `/transactions/${encodeURIComponent(args.providerReference)}/refund`,
      { method: 'POST', body: JSON.stringify({ amount: toMajor(args.amountMinor) }) },
    );

    return {
      providerReference: String(body.data.id),
      status: body.data.status === 'completed' ? 'succeeded' : 'processing',
      raw: body as unknown as Record<string, unknown>,
    };
  }
}
