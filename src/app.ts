import { DateTime } from 'luxon';
import path from 'node:path';
import { env as loadEnvironment, resolvePath, type Env } from './config/env.js';
import { logger as defaultLogger, type Logger } from './utils/logger.js';
import { openDb } from './state/db.js';
import { StateStore } from './state/stateStore.js';
import { getAuthorizedClient } from './integrations/google/auth.js';
import { GoogleSheetsRepository } from './sheets/googleSheetsRepository.js';
import { MemoryRepository } from './sheets/memoryRepository.js';
import type { TaskRepository } from './sheets/repository.js';
import { GoogleCalendarSource } from './calendar/googleCalendarSource.js';
import { AppleCalendarSource, isMacOs } from './calendar/appleCalendarSource.js';
import { IcsCalendarSource } from './calendar/icsCalendarSource.js';
import { CompositeCalendarSource } from './calendar/compositeCalendarSource.js';
import type { CalendarSource, StudyBlockWriter } from './calendar/types.js';
import { BlueBubblesClient } from './integrations/bluebubbles/client.js';
import { FakeMessagingAdapter } from './integrations/bluebubbles/fakeAdapter.js';
import type { MessagingAdapter } from './integrations/bluebubbles/types.js';
import { Messenger } from './messaging/outbound.js';
import { MathService } from './math/mathService.js';
import { AgentService } from './agent/agentService.js';
import { CommandRouter } from './commands/router.js';
import { NoopAiProvider, type AiProvider } from './ai/provider.js';
import { AnthropicProvider } from './ai/anthropicProvider.js';
import { parseRuntimeConfig, type RuntimeConfig } from './config/runtimeConfig.js';
import type { Db } from './state/db.js';

export interface BuildOptions {
  env?: Env;
  logger?: Logger;
  now?: () => Date;
  /** Forces the in-memory repository and fake bridge (simulation/tests). */
  offline?: boolean;
  repository?: TaskRepository;
  calendar?: CalendarSource;
  adapter?: MessagingAdapter;
  dbPath?: string;
}

export interface App {
  env: Env;
  logger: Logger;
  db: Db;
  state: StateStore;
  repository: TaskRepository;
  calendar: CalendarSource;
  adapter: MessagingAdapter;
  messenger: Messenger;
  agent: AgentService;
  router: CommandRouter;
  ai: AiProvider;
  studyBlockWriter: StudyBlockWriter | null;
  /** Problems found while wiring, surfaced by `doctor` rather than thrown. */
  warnings: string[];
  close(): void;
}

function buildAiProvider(env: Env, logger: Logger): AiProvider {
  // The MVP must work with no key at all — this is the default path.
  if (env.LLM_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.LLM_MODEL,
      logger,
    });
  }
  return new NoopAiProvider();
}

function buildCalendar(
  env: Env,
  logger: Logger,
  timezone: string,
  warnings: string[],
): { source: CalendarSource; writer: StudyBlockWriter | null } {
  const sources: CalendarSource[] = [];
  let writer: StudyBlockWriter | null = null;
  const requested = new Set(env.CALENDAR_SOURCES);

  if (requested.has('google')) {
    const auth = getAuthorizedClient(env);
    if (auth) {
      const google = new GoogleCalendarSource({
        auth,
        calendarIds: env.GOOGLE_CALENDAR_IDS,
        logger,
        timezone,
      });
      sources.push(google);
      if (env.STUDY_BLOCK_TARGET === 'google') writer = google;
    } else {
      warnings.push('Google Calendar requested but Google is not authorized. Run: npm run auth:google');
    }
  }

  if (requested.has('apple')) {
    if (isMacOs()) {
      const apple = new AppleCalendarSource({
        calendarNames: env.APPLE_CALENDAR_NAMES,
        logger,
      });
      sources.push(apple);
      if (env.STUDY_BLOCK_TARGET === 'apple') writer = apple;
    } else {
      warnings.push('Apple Calendar was requested but this is not macOS — skipping that source.');
    }
  }

  if (requested.has('ics')) {
    if (env.ICS_CALENDAR_URLS.length > 0) {
      sources.push(new IcsCalendarSource({ sources: env.ICS_CALENDAR_URLS, logger, timezone }));
    } else {
      warnings.push('ICS source requested but ICS_CALENDAR_URLS is empty.');
    }
  }

  if (sources.length === 0) {
    warnings.push('No calendar source is available. The agent will plan without calendar data.');
  }

  return { source: new CompositeCalendarSource(sources, logger), writer };
}

/**
 * Composition root. Everything is constructed here and injected downward, so
 * tests can replace any single piece without monkey-patching.
 */
export async function buildApp(options: BuildOptions = {}): Promise<App> {
  const env = options.env ?? loadEnvironment();
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => new Date());
  const warnings: string[] = [];

  const dbPath =
    options.dbPath ?? (options.offline ? ':memory:' : path.join(resolvePath(env.DATA_DIR), 'agent.sqlite'));
  const db = openDb(dbPath);
  const state = new StateStore(db);

  // ---- repository -------------------------------------------------------
  let repository: TaskRepository;
  if (options.repository) {
    repository = options.repository;
  } else if (options.offline) {
    repository = new MemoryRepository();
  } else {
    const auth = getAuthorizedClient(env);
    if (auth && env.SPREADSHEET_ID) {
      repository = new GoogleSheetsRepository({
        auth,
        spreadsheetId: env.SPREADSHEET_ID,
        logger,
      });
    } else {
      // Falling back keeps `doctor` and the HTTP server usable so the user can
      // see *why* it is not configured, instead of a crash on boot.
      warnings.push(
        auth
          ? 'SPREADSHEET_ID is not set. Add it to .env (SETUP.md step 8).'
          : 'Google is not authorized yet. Run: npm run auth:google',
      );
      repository = new MemoryRepository();
    }
  }

  // The timezone lives in the sheet, but the calendar clients need it at
  // construction time, so read it once up front with a safe default.
  let runtime: RuntimeConfig;
  try {
    runtime = parseRuntimeConfig(await repository.getConfig());
  } catch {
    runtime = parseRuntimeConfig({});
  }

  // ---- calendar ---------------------------------------------------------
  const calendarBuild = options.calendar
    ? { source: options.calendar, writer: null }
    : options.offline
      ? { source: new CompositeCalendarSource([], logger), writer: null }
      : buildCalendar(env, logger, runtime.timezone, warnings);

  // ---- messaging --------------------------------------------------------
  let adapter: MessagingAdapter;
  if (options.adapter) {
    adapter = options.adapter;
  } else if (options.offline || !env.BLUEBUBBLES_SERVER_URL || !env.BLUEBUBBLES_PASSWORD) {
    if (!options.offline) {
      warnings.push(
        'BLUEBUBBLES_SERVER_URL / BLUEBUBBLES_PASSWORD are not set — messages will not be delivered.',
      );
    }
    adapter = new FakeMessagingAdapter();
  } else {
    adapter = new BlueBubblesClient({
      serverUrl: env.BLUEBUBBLES_SERVER_URL,
      password: env.BLUEBUBBLES_PASSWORD,
      sendMethod: env.BLUEBUBBLES_SEND_METHOD,
      defaultChatGuid: env.CHAT_GUID,
      defaultHandle: env.TARGET_HANDLE,
      logger,
    });
  }

  if (!env.AUTHORIZED_USER_HANDLE) {
    warnings.push('AUTHORIZED_USER_HANDLE is not set — every inbound message will be ignored.');
  }
  if (!env.TARGET_HANDLE && !env.CHAT_GUID) {
    warnings.push('Neither TARGET_HANDLE nor CHAT_GUID is set — outbound messages have no destination.');
  }

  const configProvider = (): RuntimeConfig => runtime;

  const messenger = new Messenger({
    adapter,
    state,
    config: configProvider,
    logger,
    now,
    targetChatGuid: env.CHAT_GUID ?? null,
    targetHandle: env.TARGET_HANDLE ?? null,
    dryRun: env.DRY_RUN === true,
  });

  const math = new MathService({
    repository,
    state,
    now: () => DateTime.fromJSDate(now(), { zone: runtime.timezone }),
  });

  const ai = buildAiProvider(env, logger);

  const agent = new AgentService({
    repository,
    calendar: calendarBuild.source,
    state,
    math,
    ai,
    logger,
    now,
    studyBlockWriter: calendarBuild.writer,
    studyBlockCalendarName: env.STUDY_BLOCK_CALENDAR_NAME,
  });

  // Keep the cached runtime config fresh so quiet hours and limits reflect
  // edits the user makes in the sheet without needing a restart.
  const refresh = async (): Promise<void> => {
    try {
      runtime = await agent.loadConfig();
    } catch {
      /* keep the previous config */
    }
  };
  await refresh();
  const refreshTimer = setInterval(() => void refresh(), 5 * 60_000);
  refreshTimer.unref();

  const router = new CommandRouter({ agent, logger });

  return {
    env,
    logger,
    db,
    state,
    repository,
    calendar: calendarBuild.source,
    adapter,
    messenger,
    agent,
    router,
    ai,
    studyBlockWriter: calendarBuild.writer,
    warnings,
    close(): void {
      clearInterval(refreshTimer);
      db.close();
    },
  };
}

/** All handles permitted to command the agent. */
export function authorizedHandles(env: Env): string[] {
  return [env.AUTHORIZED_USER_HANDLE, ...env.ADDITIONAL_AUTHORIZED_HANDLES].filter(
    (handle): handle is string => typeof handle === 'string' && handle.trim() !== '',
  );
}
