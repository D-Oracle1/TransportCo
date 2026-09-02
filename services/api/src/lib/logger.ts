import pino from 'pino';
import { env } from '../config';

/**
 * Structured logging.
 *
 * The redaction list is not decoration. Nigerian phone numbers, OTP codes,
 * tokens and provider keys must never reach a log aggregator — once they are in
 * a log they are in backups, in alerts and on someone's laptop.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-paystack-signature"]',
      'req.headers["verif-hash"]',
      'req.body.password',
      'req.body.newPassword',
      'req.body.code',
      'req.body.refreshToken',
      'password',
      'passwordHash',
      'password_hash',
      'refreshToken',
      'refresh_token_hash',
      'codeHash',
      'code_hash',
      'otp',
      'providerToken',
      'provider_token',
      '*.password',
      '*.otp',
    ],
    censor: '[redacted]',
  },
  base: { service: 'transportco-api', env: env.NODE_ENV },
  // Human-readable timestamps in development; ISO in production for ingestion.
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings) as Logger;
}
