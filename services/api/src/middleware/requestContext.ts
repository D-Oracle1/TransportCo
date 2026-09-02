import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithContext, type RequestContext } from '../lib/context';
import { clientIp } from '../lib/http';
import { logger } from '../lib/logger';

/**
 * Establishes the per-request context and emits one structured access-log line
 * per request. The request id is echoed in the `X-Request-Id` header and in
 * every response envelope, so a customer complaint that quotes an id can be
 * traced straight to the log line and the audit rows it produced.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const inbound = req.headers['x-request-id'];
  const requestId = typeof inbound === 'string' && inbound.length <= 64 ? inbound : randomUUID();

  res.setHeader('X-Request-Id', requestId);

  const context: RequestContext = {
    requestId,
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
    claims: null,
    startedAt: Date.now(),
  };

  runWithContext(context, () => {
    res.on('finish', () => {
      const elapsedMs = Date.now() - context.startedAt;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      logger[level](
        {
          requestId,
          method: req.method,
          path: req.route?.path ?? req.originalUrl.split('?')[0],
          status: res.statusCode,
          elapsedMs,
          userId: context.claims?.sub ?? null,
        },
        'request',
      );
    });

    next();
  });
};
