import type {
  InitializePaymentRequest,
  InitializePaymentResult,
  NormalisedWebhookEvent,
  VerifyPaymentResult,
} from '@transportco/types';
import type { PaymentAdapter } from './types';
import { AppError } from '../../../lib/errors';

/**
 * Cash handler.
 *
 * Cash is still a payment with a lifecycle, not an absence of one. It is
 * recorded, reconciled and reported exactly like a card charge — the difference
 * is only who confirms it.
 *
 * Two rules enforced by the service that calls this:
 *   - The amount collected MUST equal the locked fare. A driver cannot record
 *     "the customer only had ₦5,000" as a completed payment; that becomes an
 *     outstanding balance and an operations decision.
 *   - Only the assigned driver may confirm collection, and the confirmation is
 *     recorded against them by name for the Finance reconciliation view.
 */
export class CashPaymentHandler implements PaymentAdapter {
  readonly provider = 'cash' as const;

  isConfigured(): boolean {
    return true; // cash needs no credentials
  }

  async initialize(request: InitializePaymentRequest): Promise<InitializePaymentResult> {
    // Nothing to initialise externally: the payment row is the whole record.
    return {
      provider: 'cash',
      providerReference: request.reference,
      status: 'pending',
      authorizationUrl: null,
      bankTransfer: null,
      raw: { note: 'Cash collection pending at trip completion' },
    };
  }

  async verify(): Promise<VerifyPaymentResult> {
    // There is no third party to ask. Verification for cash happens through
    // `PaymentService.recordCashCollection`, which requires the assigned
    // driver and the exact locked fare.
    throw new AppError({
      code: 'payment_verification_failed',
      message: 'Cash payments are confirmed by the assigned driver, not by provider verification',
    });
  }

  parseWebhook(): NormalisedWebhookEvent | null {
    return null; // cash has no webhooks
  }
}
