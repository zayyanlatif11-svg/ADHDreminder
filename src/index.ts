import { authorizedHandles, buildApp } from './app.js';
import { createHttpServer, startHttpServer } from './server/httpServer.js';
import { Scheduler } from './scheduler/scheduler.js';

/**
 * Entry point for the long-running local service: HTTP webhook listener +
 * scheduler. This is what the LaunchAgent starts at login.
 */
async function main(): Promise<void> {
  const app = await buildApp();
  const { logger, env } = app;

  for (const warning of app.warnings) {
    logger.warn({}, warning);
  }

  const scheduler = new Scheduler({
    agent: app.agent,
    messenger: app.messenger,
    logger,
    now: () => new Date(),
  });

  const server = createHttpServer({
    agent: app.agent,
    router: app.router,
    messenger: app.messenger,
    adapter: app.adapter,
    logger,
    scheduler,
    authorizedHandles: authorizedHandles(env),
    chatGuid: env.CHAT_GUID ?? null,
    webhookSecret: env.WEBHOOK_SECRET,
    now: () => new Date(),
  });

  const httpServer = startHttpServer(server, {
    port: env.PORT,
    host: env.HOST,
    logger,
  });

  scheduler.start();

  logger.info(
    {
      webhook: `http://${env.HOST}:${env.PORT}/webhook/bluebubbles`,
      llm: app.ai.enabled ? app.ai.name : 'disabled',
    },
    'execution-agent is running',
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    httpServer.close(() => {
      app.close();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crash in a background job should be logged, not silently fatal.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled promise rejection');
  });
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start execution-agent:', error instanceof Error ? error.message : error);
  process.exit(1);
});
