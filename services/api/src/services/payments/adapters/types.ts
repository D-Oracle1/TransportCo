import type {
  InitializePaymentRequest,
  InitializePaymentResult,
  NormalisedWebhookEvent,
  PaymentProvider,
  VerifyPaymentResult,
  WebhookVerificationInput,
} from '@transportco/types';

/**
 * The contract every payment provider implements.
 *
 * Trip logic never imports Paystack or Flutterwave. It talks to
 * `PaymentService`, which selects an adapter. Adding a provider — or switching
 * because one has a bad week, which happens — is a new file here plus a config
 * value, not a change to the booking flow.
 */
export interface PaymentAdapter {
  readonly provider: PaymentProvider;

  /** Whether this adapter can currently take money (credentials configured). */
  isConfigured(): boolean;

  initialize(request: InitializePaymentRequest): Promise<InitializePaymentResult>;

  /**
   * Server-to-server verification. This — never the client's word — is what
   * marks a payment as succeeded.
   */
  verify(providerReference: string): Promise<VerifyPaymentResult>;

  /**
   * Verify a webhook signature and normalise the payload.
   * Returns null when the signature does not check out; the caller records the
   * attempt and returns 400 without touching any payment.
   */
  parseWebhook(input: WebhookVerificationInput): NormalisedWebhookEvent | null;

  refund?(args: { providerReference: string; amountMinor: number; reason: string }): Promise<{
    providerReference: string;
    status: 'processing' | 'succeeded' | 'failed';
    raw: Record<string, unknown>;
  }>;
}
