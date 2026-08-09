import cron, { type ScheduledTask } from 'node-cron';
import { DateTime } from 'luxon';
import type { AgentService } from '../agent/agentService.js';
import type { Messenger } from '../messaging/outbound.js';
import type { Logger } from '../utils/logger.js';
import {
  runMaintenanceJob,
  runMorningJob,
  runStudyBlockJob,
  runWeeklyHealthJob,
  type JobDeps,
} from './jobs.js';

export interface SchedulerDeps extends JobDeps {
  agent: AgentService;
  messenger: Messenger;
  logger: Logger;
  now: () => Date;
}

/**
 * Local scheduler.
 *
 * Design note: the morning message is NOT driven by a single cron firing at
 * 08:00. On a laptop that is closed overnight, that firing simply never
 * happens. Instead a cheap tick runs every few minutes and asks
 * `runMorningJob` whether today's message is still owed — the job itself owns
 * the "once per day" and "too late to bother" decisions, backed by the SQLite
 * claim. That makes sleep, restarts, and clock changes all behave the same way.
 */
export class Scheduler {
  private readonly tasks: ScheduledTask[] = [];
  private running = false;
  private lastTickAt: Date | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  get lastTick(): Date | null {
    return this.lastTickAt;
  }

  start(): void {
    if (this.running) return;

    // Every 5 minutes: is the morning message still owed?
    this.tasks.push(
      cron.schedule('*/5 * * * *', () => {
        void this.tick();
      }),
    );

    // Hourly: weekly health check + study blocks + housekeeping.
    this.tasks.push(
      cron.schedule('7 * * * *', () => {
        void this.hourly();
      }),
    );

    this.running = true;
    this.deps.logger.info({}, 'scheduler started');

    // Run once immediately so a restart mid-morning catches up without waiting.
    void this.tick();
  }

  stop(): void {
    for (const task of this.tasks) task.stop();
    this.tasks.length = 0;
    this.running = false;
    this.deps.logger.info({}, 'scheduler stopped');
  }

  /** Exposed so tests and `doctor` can drive a tick without waiting on cron. */
  async tick(): Promise<void> {
    this.lastTickAt = new Date(this.deps.now());
    try {
      const result = await runMorningJob(this.deps);
      if (result.sent) this.deps.logger.info({}, 'morning message sent');
    } catch (error) {
      this.deps.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'morning job failed',
      );
    }
  }

  async hourly(): Promise<void> {
    try {
      const config = await this.deps.agent.loadConfig();
      const now = DateTime.fromJSDate(this.deps.now(), { zone: config.timezone });

      const [targetHour, targetMinute] = config.weekly_health_time.split(':').map(Number);
      const isDay = now.weekday === config.weekly_health_day;
      const isHour = now.hour === (targetHour ?? 9);

      if (isDay && isHour && now.minute >= (targetMinute ?? 0)) {
        await runWeeklyHealthJob(this.deps);
      }

      await runStudyBlockJob(this.deps);
      await runMaintenanceJob(this.deps);
    } catch (error) {
      this.deps.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'hourly job failed',
      );
    }
  }
}
