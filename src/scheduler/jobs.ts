import { DateTime } from 'luxon';
import type { AgentService } from '../agent/agentService.js';
import type { Messenger } from '../messaging/outbound.js';
import type { Logger } from '../utils/logger.js';
import { buildDailyPlan } from '../prioritization/planner.js';
import { formatMorningMessage, formatSchoolHealth } from '../messaging/formatter.js';
import { planStudyBlocks, syncStudyBlocks } from '../calendar/studyBlocks.js';
import { isOpen } from '../tasks/types.js';
import { parseClockTime } from '../utils/time.js';

export interface JobDeps {
  agent: AgentService;
  messenger: Messenger;
  logger: Logger;
}

export const MORNING_KIND = 'morning';
export const WEEKLY_KIND = 'weekly_health';

export interface MorningResult {
  sent: boolean;
  reason?: 'already_sent' | 'too_late' | 'quiet_hours' | 'not_yet' | 'suppressed';
  body?: string;
}

/**
 * The daily plan message.
 *
 * Handles the laptop-was-asleep case: if the scheduled time passed while the
 * Mac was off, the message still goes out when it wakes — but only while it is
 * still early enough to be useful. A "morning" plan arriving at 6pm is noise,
 * so past the cutoff it is skipped entirely rather than sent late.
 */
export async function runMorningJob(
  deps: JobDeps,
  options: { force?: boolean } = {},
): Promise<MorningResult> {
  const { agent, messenger, logger } = deps;
  const context = await agent.buildContext();
  const dayKey = context.now.toFormat('yyyy-LL-dd');

  if (!options.force && agent.state.hasSentToday(MORNING_KIND, dayKey)) {
    return { sent: false, reason: 'already_sent' };
  }

  const scheduled = parseClockTime(context.config.morning_time) ?? 8 * 60;
  const cutoff = parseClockTime(context.config.morning_catchup_cutoff) ?? 12 * 60;
  const minutesNow = context.now.hour * 60 + context.now.minute;

  if (!options.force && minutesNow < scheduled) {
    return { sent: false, reason: 'not_yet' };
  }
  if (!options.force && minutesNow > cutoff) {
    logger.info(
      { minutesNow, cutoff },
      'past the morning catch-up cutoff — skipping a stale morning message',
    );
    // Claim the slot so a later tick does not send it either.
    agent.state.claimDailySend(MORNING_KIND, dayKey, 'skipped:stale');
    return { sent: false, reason: 'too_late' };
  }

  // Housekeeping happens before the plan so the plan reflects it.
  await agent.runRollover(context);
  await agent.syncFromCalendar(context);

  const refreshed = await agent.buildContext();
  const plan = buildDailyPlan(refreshed.tasks, {
    now: refreshed.now,
    zone: refreshed.zone,
    config: refreshed.config,
    courses: refreshed.courses,
    rescueActive: refreshed.rescueActive,
    academicMinimumMet: refreshed.academicMinimumMet,
    freeMinutesToday: refreshed.freeMinutesToday,
  });

  // Fill in concrete first actions before the message is written.
  for (const entry of plan.entries) {
    await agent.resolveNextAction(entry.task);
  }

  const finalContext = await agent.buildContext();
  await agent.getOrBuildPlan(finalContext, { rebuild: true });

  const body = formatMorningMessage({
    now: finalContext.now,
    zone: finalContext.zone,
    entries: plan.entries.map((entry) => ({
      ...entry,
      task: finalContext.tasks.find((t) => t.id === entry.task.id) ?? entry.task,
    })),
    keystone: plan.keystone,
    courses: finalContext.courses,
    rescue: plan.rescue,
    autoRescue: plan.rescue,
  });

  const result = await messenger.sendOncePerDay(body, { kind: MORNING_KIND, dayKey });
  if (result.ok && !result.suppressed) {
    await agent.logEvent('morning_message', { result: 'sent' });
    return { sent: true, body };
  }
  return {
    sent: false,
    reason: result.suppressedReason === 'quiet_hours' ? 'quiet_hours' : 'suppressed',
    body,
  };
}

/**
 * Weekly academic health. Grades are only shown when the user actually entered
 * them in the COURSES tab — never invented.
 */
export async function runWeeklyHealthJob(
  deps: JobDeps,
  options: { force?: boolean } = {},
): Promise<{ sent: boolean; body?: string }> {
  const { agent, messenger } = deps;
  const context = await agent.buildContext();
  const dayKey = context.now.toFormat('yyyy-LL-dd');

  if (!options.force && agent.state.hasSentToday(WEEKLY_KIND, dayKey)) {
    return { sent: false };
  }

  const open = context.tasks.filter(isOpen);

  const missing = open.filter((task) => {
    if (task.category !== 'academic' || !task.dueAt) return false;
    const due = DateTime.fromISO(task.dueAt, { zone: context.zone });
    return due.isValid && due < context.now;
  }).length;

  const dueNext7 = open.filter((task) => {
    if (task.category !== 'academic' || !task.dueAt) return false;
    const due = DateTime.fromISO(task.dueAt, { zone: context.zone });
    if (!due.isValid) return false;
    const days = due.diff(context.now, 'days').days;
    return days >= 0 && days <= 7;
  }).length;

  const examsNext14 = open.filter((task) => {
    if (!task.dueAt || task.importance < 5) return false;
    const due = DateTime.fromISO(task.dueAt, { zone: context.zone });
    if (!due.isValid) return false;
    const days = due.diff(context.now, 'days').days;
    return days >= 0 && days <= 14 && /exam|midterm|final|test/i.test(task.title);
  }).length;

  const riskiest =
    context.courses.find((course) => course.riskLevel === 'red') ??
    context.courses.find((course) => course.riskLevel === 'yellow') ??
    null;

  const body = formatSchoolHealth({
    courses: context.courses,
    missingCount: missing,
    dueNext7Days: dueNext7,
    examsNext14Days: examsNext14,
    mainObjective: riskiest ? `${riskiest.name} fundamentals.` : 'Keep the streak going.',
  });

  const result = await messenger.sendOncePerDay(body, { kind: WEEKLY_KIND, dayKey });
  if (result.ok && !result.suppressed) {
    await agent.logEvent('weekly_health', { result: 'sent' });
    return { sent: true, body };
  }
  return { sent: false, body };
}

/**
 * Regenerates study blocks in the agent's own calendar. Opt-in via
 * `study_block_calendar_enabled`; a no-op otherwise.
 */
export async function runStudyBlockJob(deps: JobDeps): Promise<{ created: number; removed: number } | null> {
  const { agent, logger } = deps;
  const context = await agent.buildContext();

  if (!context.config.study_block_calendar_enabled) return null;
  const writer = agent.studyBlockWriter;
  if (!writer) {
    logger.warn({}, 'study blocks are enabled but no writable calendar backend is configured');
    return null;
  }

  const planned = planStudyBlocks(context.tasks, context.events, {
    zone: context.zone,
    now: context.now,
    horizonDays: Math.min(7, context.config.calendar_lookahead_days),
    maxSessionMinutes: context.config.max_study_session_minutes,
    bufferMinutes: context.config.transition_buffer_minutes,
    dayStart: context.config.quiet_hours_end,
    dayEnd: context.config.quiet_hours_start,
    // Leave most of the day unscheduled — an over-packed calendar gets ignored.
    maxMinutesPerDay: Math.max(60, Math.round(context.config.max_study_session_minutes * 3)),
  });

  return syncStudyBlocks(planned, {
    writer,
    calendarName: agent.studyBlockCalendarName,
    from: context.now.toJSDate(),
    to: context.now.plus({ days: 7 }).toJSDate(),
    logger,
  });
}

/** Periodic housekeeping so the local database does not grow forever. */
export async function runMaintenanceJob(deps: JobDeps): Promise<void> {
  const pruned = deps.agent.state.pruneProcessedEvents(30);
  if (pruned > 0) deps.logger.info({ pruned }, 'pruned old webhook dedupe rows');
}
