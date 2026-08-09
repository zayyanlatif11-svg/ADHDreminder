import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DateTime } from 'luxon';
import { MemoryRepository } from '../sheets/memoryRepository.js';
import { StaticCalendarSource } from '../calendar/compositeCalendarSource.js';
import { FakeMessagingAdapter } from '../integrations/bluebubbles/fakeAdapter.js';
import { openMemoryDb } from '../state/db.js';
import { StateStore } from '../state/stateStore.js';
import { MathService } from '../math/mathService.js';
import { NoopAiProvider } from '../ai/provider.js';
import { AgentService } from '../agent/agentService.js';
import { CommandRouter } from '../commands/router.js';
import { Messenger } from '../messaging/outbound.js';
import { parseRuntimeConfig } from '../config/runtimeConfig.js';
import { silentLogger } from '../utils/logger.js';
import { runMorningJob } from '../scheduler/jobs.js';
import { rankTasks } from '../prioritization/engine.js';
import { seedCalendarEvents, seedCourses, seedMastery, seedTasks } from './seedData.js';
import { CONFIG_SEED_ROWS } from '../config/runtimeConfig.js';

/**
 * Runs the entire command flow locally with no Google account, no Mac, and no
 * iMessage. Nothing leaves the machine.
 */

const SCRIPTED_DEMO = [
  'TODAY',
  'WHAT NOW',
  'STUCK',
  'STUCK',
  'STUCK',
  'READY',
  'DONE',
  'ADD finish calc worksheet tomorrow',
  'SNOOZE 2h',
  'RESCUE',
  'MATH',
  '3',
  'HELP',
];

export interface SimulationHarness {
  agent: AgentService;
  router: CommandRouter;
  repository: MemoryRepository;
  state: StateStore;
  messenger: Messenger;
  adapter: FakeMessagingAdapter;
  now: () => Date;
  setNow(at: DateTime): void;
  close(): void;
}

/** Builds a fully in-memory agent. Also used by the test suite. */
export function createSimulation(
  options: { at?: string; zone?: string } = {},
): SimulationHarness {
  const zone = options.zone ?? 'America/Los_Angeles';
  // A fixed Saturday-morning default so simulation output is reproducible.
  let current = DateTime.fromISO(options.at ?? '2026-08-08T08:05:00', { zone });
  if (!current.isValid) current = DateTime.fromISO('2026-08-08T08:05:00', { zone });

  const now = (): Date => current.toJSDate();

  const config: Record<string, string> = {};
  for (const [key, value] of CONFIG_SEED_ROWS) config[key] = value;

  const repository = new MemoryRepository({
    config,
    tasks: seedTasks(current),
    courses: seedCourses(),
    mastery: seedMastery(),
  });

  const db = openMemoryDb();
  const state = new StateStore(db);
  const adapter = new FakeMessagingAdapter();
  const calendar = new StaticCalendarSource(seedCalendarEvents(current));

  const runtime = parseRuntimeConfig(config);
  const messenger = new Messenger({
    adapter,
    state,
    config: () => runtime,
    logger: silentLogger,
    now,
    targetHandle: '+15550000000',
  });

  const math = new MathService({
    repository,
    state,
    now: () => current,
    // Deterministic question selection so simulation output does not churn.
    random: () => 0.42,
  });

  const agent = new AgentService({
    repository,
    calendar,
    state,
    math,
    ai: new NoopAiProvider(),
    logger: silentLogger,
    now,
  });

  const router = new CommandRouter({ agent, logger: silentLogger });

  return {
    agent,
    router,
    repository,
    state,
    messenger,
    adapter,
    now,
    setNow(at: DateTime) {
      current = at;
    },
    close() {
      db.close();
    },
  };
}

function banner(text: string): void {
  stdout.write(`\n\x1b[1m${text}\x1b[0m\n${'─'.repeat(Math.min(60, text.length + 4))}\n`);
}

function printReply(reply: string): void {
  const framed = reply
    .split('\n')
    .map((line) => `  │ ${line}`)
    .join('\n');
  stdout.write(`${framed}\n`);
}

async function runScripted(harness: SimulationHarness): Promise<void> {
  banner('SIMULATION — scripted walkthrough');
  stdout.write('No messages are sent. Nothing touches Google or iMessage.\n');

  banner('Morning message (what would be sent at 08:00)');
  const morning = await runMorningJob({
    agent: harness.agent,
    messenger: harness.messenger,
    logger: silentLogger,
  });
  printReply(morning.body ?? '(nothing to send)');

  // Shown before the scripted commands run, so the ranking reflects a normal
  // day rather than the post-RESCUE filtered view.
  banner('Why academics won (full ranking, highest first)');
  const context = await harness.agent.buildContext();
  const { ranked, excluded } = rankTasks(context.tasks, {
    now: context.now,
    zone: context.zone,
    config: context.config,
    courses: context.courses,
    rescueActive: context.rescueActive,
    academicMinimumMet: context.academicMinimumMet,
  });
  for (const entry of ranked) {
    stdout.write(
      `  ${String(Math.round(entry.score)).padStart(4)}  ${entry.task.category.padEnd(12)} ${entry.task.title}\n`,
    );
  }
  if (excluded.length > 0) {
    stdout.write('\n  Not eligible right now:\n');
    for (const entry of excluded) {
      stdout.write(
        `     —    ${entry.task.category.padEnd(12)} ${entry.task.title}  \x1b[90m(${entry.reason})\x1b[0m\n`,
      );
    }
  }
  stdout.write(
    '\nAcademics lead the ranking, and startup work is hidden entirely until\ntoday\'s academic minimum is met — even though it is the most fun item here.\n',
  );

  for (const command of SCRIPTED_DEMO) {
    banner(`> ${command}`);
    const { reply } = await harness.router.route(command);
    printReply(reply);
  }
}

async function runInteractive(harness: SimulationHarness): Promise<void> {
  banner('SIMULATION — interactive');
  stdout.write(
    'Type commands as if texting the agent. Nothing is sent anywhere.\nTry: WHAT NOW, STUCK, DONE, RESCUE, ADD finish calc worksheet tomorrow\nType "exit" to quit.\n',
  );

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const line = (await rl.question('\nyou> ')).trim();
      if (line === '') continue;
      if (/^(exit|quit|q)$/i.test(line)) break;
      const { reply } = await harness.router.route(line);
      printReply(reply);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const harness = createSimulation();
  const interactive = process.argv.includes('--interactive') || process.argv.includes('-i');
  try {
    if (interactive) await runInteractive(harness);
    else {
      await runScripted(harness);
      stdout.write('\nRun `npm run simulate -- --interactive` to type your own commands.\n');
    }
  } finally {
    harness.close();
  }
}

// Only run when invoked directly, so tests can import createSimulation().
const invokedDirectly = process.argv[1]?.includes('simulate');
if (invokedDirectly) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Simulation failed:', error);
    process.exit(1);
  });
}
