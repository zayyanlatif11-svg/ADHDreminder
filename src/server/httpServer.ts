import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AgentService } from '../agent/agentService.js';
import type { CommandRouter } from '../commands/router.js';
import type { Messenger } from '../messaging/outbound.js';
import type { MessagingAdapter } from '../integrations/bluebubbles/types.js';
import type { Logger } from '../utils/logger.js';
import { authorizeInbound } from '../messaging/authorization.js';
import type { Scheduler } from '../scheduler/scheduler.js';

export interface HttpServerDeps {
  agent: AgentService;
  router: CommandRouter;
  messenger: Messenger;
  adapter: MessagingAdapter;
  logger: Logger;
  scheduler?: Scheduler;
  authorizedHandles: string[];
  chatGuid?: string | null;
  /** When set, the webhook path must carry `?secret=...` matching this. */
  webhookSecret?: string | undefined;
  now: () => Date;
}

/** Constant-time comparison so a wrong secret leaks no timing information. */
function secretMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createHttpServer(deps: HttpServerDeps): Express {
  const app = express();

  // Bound the body: a personal webhook never needs more than this, and it
  // stops a malformed or hostile payload from consuming memory.
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      scheduler: deps.scheduler?.isRunning ?? false,
      lastTick: deps.scheduler?.lastTick?.toISOString() ?? null,
      time: new Date(deps.now()).toISOString(),
    });
  });

  app.post('/webhook/bluebubbles', (req: Request, res: Response) => {
    // Always 200 quickly: BlueBubbles retries on failure, and a retry storm on
    // a slow command would be worse than a dropped event.
    if (deps.webhookSecret) {
      const provided = typeof req.query['secret'] === 'string' ? req.query['secret'] : '';
      if (!secretMatches(deps.webhookSecret, provided)) {
        deps.logger.warn({ ip: req.ip }, 'webhook rejected: bad secret');
        res.status(401).json({ ok: false });
        return;
      }
    }

    res.status(200).json({ ok: true });
    void handleWebhook(deps, req.body);
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false });
  });

  return app;
}

async function handleWebhook(deps: HttpServerDeps, body: unknown): Promise<void> {
  // The caller has already replied 200 and does not await this, so nothing here
  // may escape as an unhandled rejection.
  try {
    await processWebhook(deps, body);
  } catch (error) {
    deps.logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'webhook processing failed',
    );
  }
}

async function processWebhook(deps: HttpServerDeps, body: unknown): Promise<void> {
  const { adapter, agent, logger, router, messenger } = deps;

  let message;
  try {
    message = adapter.parseWebhook(body);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'webhook parse threw',
    );
    return;
  }
  if (!message) return;

  // Idempotency first: BlueBubbles can deliver the same event more than once,
  // and re-running a command would double-complete a task.
  if (!agent.state.markEventProcessed(message.messageId)) {
    logger.debug({ messageId: message.messageId }, 'duplicate webhook ignored');
    return;
  }

  const verdict = authorizeInbound(message, {
    authorizedHandles: deps.authorizedHandles,
    chatGuid: deps.chatGuid ?? null,
  });

  if (!verdict.allowed) {
    // `from_bot` is the common, expected case — the agent seeing its own sends.
    if (verdict.reason !== 'from_bot') {
      logger.warn({ reason: verdict.reason }, 'inbound message rejected');
      await agent.logEvent('inbound_rejected', {
        messageId: message.messageId,
        result: verdict.reason ?? 'rejected',
      });
    }
    return;
  }

  const config = await agent.loadConfig();
  const allowed = agent.state.consumeRateLimit(
    'commands',
    config.max_commands_per_minute,
    60,
    new Date(deps.now()),
  );
  if (!allowed) {
    logger.warn({}, 'inbound command dropped by rate limit');
    return;
  }

  try {
    const { reply, command } = await router.route(message.text);
    await messenger.send(reply, {
      kind: 'reply',
      chatGuid: message.chatGuid ?? undefined,
    });
    logger.info({ command: command.name }, 'handled command');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'failed to handle inbound command',
    );
  }
}

export function startHttpServer(
  app: Express,
  options: { port: number; host: string; logger: Logger },
): Server {
  const server = app.listen(options.port, options.host, () => {
    options.logger.info(
      { port: options.port, host: options.host },
      'listening for BlueBubbles webhooks',
    );
  });
  return server;
}
