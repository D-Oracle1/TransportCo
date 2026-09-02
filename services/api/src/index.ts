import { createServer } from 'node:http';
import { describeConfig } from '@transportco/config/env';
import { createApp } from './app';
import { env } from './config';
import { logger } from './lib/logger';
import { closePool, healthCheck } from './db/pool';
import { initialiseRealtime, shutdownRealtime } from './services/realtime/gateway';
import { startScheduler, stopScheduler } from './workers/scheduler';

/**
 * Process entry point.
 *
 * Two things worth doing properly here:
 *
 *  - FAIL FAST. The database is checked before the port opens. A process that
 *    accepts traffic it cannot serve just turns one alert into a thousand.
 *  - SHUT DOWN GRACEFULLY. On SIGTERM, stop taking new connections, let
 *    in-flight requests finish, then close the pool. A trip transaction cut in
 *    half by a deploy is the kind of thing that costs a day of reconciliation.
 */

async function main(): Promise<void> {
  logger.info({ config: describeConfig(env) }, 'Starting TransportCo API');

  const databaseReady = await healthCheck();
  if (!databaseReady) {
    logger.fatal('Database is not reachable. Refusing to start.');
    process.exit(1);
  }

  const app = createApp();
  const server = createServer(app);

  initialiseRealtime(server);
  startScheduler();

  server.listen(env.API_PORT, () => {
    logger.info({ port: env.API_PORT, env: env.NODE_ENV }, 'TransportCo API listening');
  });

  // Nigerian mobile clients on slow links need a generous header timeout;
  // keepAlive slightly below the load balancer's idle timeout avoids the
  // classic 502-on-reused-connection.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down');
    stopScheduler();
    shutdownRealtime();

    server.close(() => {
      void closePool().then(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      });
    });

    // Backstop: if something refuses to let go, do not hang the deploy forever.
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    // An uncaught exception leaves the process in an unknown state. Log it and
    // let the supervisor restart cleanly rather than limping on.
    logger.fatal({ err: error }, 'Uncaught exception');
    shutdown('uncaughtException');
  });
}

void main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start');
  process.exit(1);
});
