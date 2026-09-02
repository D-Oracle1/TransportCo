import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { asyncHandler, sendOk } from './lib/http';
import { requestContext } from './middleware/requestContext';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { standardRateLimit } from './middleware/rateLimit';
import { healthCheck } from './db/pool';
import { env } from './config';
import { authRouter } from './modules/auth/routes';
import { customerRouter } from './modules/customers/routes';
import { tripRouter } from './modules/trips/routes';
import { driverRouter } from './modules/drivers/routes';
import { paymentCallbackRouter, paymentRouter, webhookRouter } from './modules/payments/routes';
import { supportRouter } from './modules/support/routes';
import { adminOperationsRouter } from './modules/admin/operations';
import { adminPeopleRouter } from './modules/admin/people';
import { adminBusinessRouter } from './modules/admin/business';

/**
 * Express application assembly.
 *
 * Middleware ORDER is load-bearing here:
 *
 *   1. requestContext — everything after it can log with a request id.
 *   2. helmet + cors  — before any route touches a body.
 *   3. WEBHOOKS       — mounted BEFORE the JSON parser, because provider
 *                       signatures are computed over raw bytes. Parsing and
 *                       re-serialising JSON invalidates every signature.
 *   4. JSON parser    — for everything else.
 *   5. Routes.
 *   6. notFound, then errorHandler last.
 */
export function createApp(): Express {
  const app = express();

  // Behind a load balancer, so req.ip and X-Forwarded-For must be trusted for
  // rate limiting and audit logging to record the real client address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestContext);

  app.use(
    helmet({
      // The API serves JSON and one trivial payment-callback page; the strict
      // default CSP is right and nothing here needs to relax it.
      contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Mobile apps send no Origin header at all; browsers must be on the list.
        if (!origin) return callback(null, true);
        if (env.CORS_ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'X-Device-Id'],
      exposedHeaders: ['X-Request-Id', 'X-RateLimit-Remaining', 'Retry-After', 'Idempotent-Replay'],
      maxAge: 86_400,
    }),
  );

  // --- Health ---------------------------------------------------------------
  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'transportco-api', at: new Date().toISOString() });
  });

  app.get(
    '/health/ready',
    asyncHandler(async (_req, res) => {
      const database = await healthCheck();
      res.status(database ? 200 : 503).json({ ok: database, checks: { database } });
    }),
  );

  // --- Webhooks (raw body, before the JSON parser) --------------------------
  app.use('/payments/webhook', webhookRouter);

  // --- Body parsing ---------------------------------------------------------
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  // --- Routes ---------------------------------------------------------------
  app.use('/auth', authRouter);
  app.use('/customer', standardRateLimit, customerRouter);
  app.use('/trips', standardRateLimit, tripRouter);
  app.use('/drivers', standardRateLimit, driverRouter);
  app.use('/payments', standardRateLimit, paymentRouter);
  app.use('/payments', paymentCallbackRouter);
  app.use('/support', standardRateLimit, supportRouter);

  app.use('/admin', standardRateLimit, adminOperationsRouter);
  app.use('/admin', standardRateLimit, adminPeopleRouter);
  app.use('/admin', standardRateLimit, adminBusinessRouter);

  // --- Service description --------------------------------------------------
  app.get('/', (_req, res) => {
    sendOk(res, {
      service: 'TransportCo API',
      version: '0.1.0',
      docs: '/docs/api.md',
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
