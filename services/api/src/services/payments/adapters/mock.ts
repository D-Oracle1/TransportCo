import { randomUUID } from 'node:crypto';
import type {
  InitializePaymentRequest,
  InitializePaymentResult,
  NormalisedWebhookEvent,
  VerifyPaymentResult,
  WebhookVerificationInput,
} from '@transportco/types';
import type { PaymentAdapter } from './types';
import { isProduction } from '../../../config';

/**
 * Development adapter.
 *
 * It does NOT fake a success. `initialize` returns a pending payment and a
 * local URL; `verify` returns whatever the developer drove the mock to via the
 * webhook endpoint. Nothing here ever marks money as received on its own,
 * because a mock that silently succeeds trains a team to trust a payment path
 * that has never actually worked.
 *
 * Production configuration refuses to boot with this selected — see the
 * consistency checks in packages/config.
 */
export class MockPaymentAdapter implements PaymentAdapter {
  readonly provider = 'mock' as const;

  private readonly state = new Map<string, VerifyPaymentResult>();

  constructor() {
    if (isProduction) {
      throw new Error('MockPaymentAdapter must never be constructed in production');
    }
  }

  isConfigured(): boolean {
    return true;
  }

  async initialize(request: InitializePaymentRequest): Promise<InitializePaymentResult> {
    const providerReference = `mock_${randomUUID()}`;

    this.state.set(providerReference, {
      provider: 'mock',
      providerReference,
      status: 'pending',
      amountMinor: request.amountMinor,
      currency: request.currency,
      paidAt: null,
      raw: { note: 'Mock payment awaiting simulated confirmation' },
    });

    return {
      provider: 'mock',
      providerReference,
      status: 'pending',
      // A developer opens this to simulate the customer completing checkout.
      authorizationUrl: `/dev/payments/${providerReference}/complete`,
      bankTransfer: {
        accountNumber: '0000000000',
        accountName: 'TRANSPORTCO (TEST)',
        bankName: 'Mock Bank',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
      raw: { mock: true },
    };
  }

  async verify(providerReference: string): Promise<VerifyPaymentResult> {
    const existing = this.state.get(providerReference);
    if (existing) return existing;

    return {
      provider: 'mock',
      providerReference,
      status: 'pending',
      amountMinor: 0,
      currency: 'NGN',
      paidAt: null,
      raw: { note: 'Unknown mock reference' },
    };
  }

  /** Test helper: drives a mock payment to a terminal state. */
  simulate(providerReference: string, status: 'succeeded' | 'failed', amountMinor: number): void {
    this.state.set(providerReference, {
      provider: 'mock',
      providerReference,
      status,
      amountMinor,
      currency: 'NGN',
      paidAt: status === 'succeeded' ? new Date().toISOString() : null,
      raw: { simulated: true },
    });
  }

  parseWebhook(input: WebhookVerificationInput): NormalisedWebhookEvent | null {
    const payload = JSON.parse(input.rawBody) as {
      reference: string;
      status: 'succeeded' | 'failed';
      amountMinor: number;
      eventId?: string;
    };

    return {
      provider: 'mock',
      eventId: payload.eventId ?? `mock:${payload.reference}:${payload.status}`,
      event: `charge.${payload.status}`,
      reference: payload.reference,
      providerReference: payload.reference,
      status: payload.status,
      amountMinor: payload.amountMinor,
      currency: 'NGN',
      paidAt: payload.status === 'succeeded' ? new Date().toISOString() : null,
      raw: payload as unknown as Record<string, unknown>,
    };
  }
}
