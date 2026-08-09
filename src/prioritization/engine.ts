import { DateTime } from 'luxon';
import type { RuntimeConfig } from '../config/runtimeConfig.js';
import type { Course, Task } from '../tasks/types.js';
import { isOpen } from '../tasks/types.js';
import { scoreAll, type ScoredTask } from './score.js';

export interface EligibilityContext {
  now: DateTime;
  zone: string;
  config: RuntimeConfig;
  /** True while rescue mode is in effect for today. */
  rescueActive: boolean;
  /** True once the day's academic minimum has been met. */
  academicMinimumMet: boolean;
}

export type ExclusionReason =
  | 'closed'
  | 'snoozed'
  | 'academic_lock'
  | 'rescue_filter'
  | 'no_time_fit';

export interface Eligibility {
  eligible: boolean;
  reason?: ExclusionReason;
}

/**
 * A snoozed task is invisible until its snooze expires — but it is never lost.
 * Once the snooze passes it re-enters scoring with its normal priority.
 */
export function isSnoozed(task: Task, now: DateTime, zone: string): boolean {
  if (task.status !== 'snoozed') {
    // A snooze timestamp on a non-snoozed task still counts; the user may have
    // edited the sheet directly.
    if (!task.snoozedUntil) return false;
  }
  if (!task.snoozedUntil) return task.status === 'snoozed';
  const until = DateTime.fromISO(task.snoozedUntil, { zone });
  if (!until.isValid) return false;
  return until > now;
}

/**
 * The academic lock. While an academic must-do is outstanding, startup work is
 * hidden from recommendations — it stays in the sheet, it just stops competing.
 * Career work with a hard deadline is explicitly allowed to override.
 */
export function isLockedByAcademics(task: Task, context: EligibilityContext): boolean {
  if (!context.config.academic_lock_enabled) return false;
  if (context.academicMinimumMet) return false;
  if (task.category !== 'startup') return false;

  // A hard-deadline startup commitment within 24h behaves like a fixed
  // obligation and is not suppressed.
  if (task.dueAt) {
    const due = DateTime.fromISO(task.dueAt, { zone: context.zone });
    if (due.isValid && due.diff(context.now, 'hours').hours <= 24 && task.importance >= 4) {
      return false;
    }
  }
  return true;
}

/**
 * Rescue mode strips the day back to what actually protects the GPA.
 */
export function isFilteredByRescue(task: Task, context: EligibilityContext): boolean {
  if (!context.rescueActive) return false;

  switch (task.category) {
    case 'startup':
    case 'learning':
    case 'personal':
      return true;
    case 'recruiting': {
      // Only a genuinely imminent recruiting deadline survives rescue.
      if (!task.dueAt) return true;
      const due = DateTime.fromISO(task.dueAt, { zone: context.zone });
      if (!due.isValid) return true;
      return !(due.diff(context.now, 'hours').hours <= 48 && task.importance >= 4);
    }
    case 'career_fixed':
    case 'academic':
      return false;
    default:
      return true;
  }
}

export function evaluateEligibility(task: Task, context: EligibilityContext): Eligibility {
  if (!isOpen(task)) return { eligible: false, reason: 'closed' };
  if (isSnoozed(task, context.now, context.zone)) return { eligible: false, reason: 'snoozed' };
  if (isLockedByAcademics(task, context)) return { eligible: false, reason: 'academic_lock' };
  if (isFilteredByRescue(task, context)) return { eligible: false, reason: 'rescue_filter' };
  return { eligible: true };
}

export interface RankOptions extends EligibilityContext {
  courses: Course[];
}

export interface RankedResult {
  ranked: ScoredTask[];
  excluded: Array<{ task: Task; reason: ExclusionReason }>;
}

export function rankTasks(tasks: Task[], options: RankOptions): RankedResult {
  const coursesById = new Map(options.courses.map((course) => [course.courseId, course]));
  const eligible: Task[] = [];
  const excluded: Array<{ task: Task; reason: ExclusionReason }> = [];

  for (const task of tasks) {
    const verdict = evaluateEligibility(task, options);
    if (verdict.eligible) eligible.push(task);
    else if (verdict.reason) excluded.push({ task, reason: verdict.reason });
  }

  return {
    ranked: scoreAll(eligible, { now: options.now, zone: options.zone, coursesById }),
    excluded,
  };
}

/**
 * Have the day's academic obligations been met?
 *
 * Two independent ways to satisfy it, because either is a real signal of a
 * productive academic day:
 *  1. enough academic minutes completed today, or
 *  2. no academic task remains that is due within the next two days.
 */
export function computeAcademicMinimumMet(
  tasks: Task[],
  options: { now: DateTime; zone: string; config: RuntimeConfig },
): { met: boolean; completedMinutes: number; outstanding: Task[] } {
  const { now, zone, config } = options;
  const todayKey = now.toFormat('yyyy-LL-dd');

  const completedMinutes = tasks
    .filter((task) => task.category === 'academic' && task.status === 'completed')
    .filter((task) => {
      if (!task.completedAt) return false;
      const at = DateTime.fromISO(task.completedAt, { zone });
      return at.isValid && at.toFormat('yyyy-LL-dd') === todayKey;
    })
    .reduce((sum, task) => sum + task.estimatedMinutes, 0);

  const outstanding = tasks
    .filter((task) => task.category === 'academic' && isOpen(task))
    .filter((task) => !isSnoozed(task, now, zone))
    .filter((task) => {
      if (!task.dueAt) return false;
      const due = DateTime.fromISO(task.dueAt, { zone });
      if (!due.isValid) return false;
      return due.diff(now, 'hours').hours <= 48;
    });

  const met = completedMinutes >= config.academic_minimum_minutes || outstanding.length === 0;
  return { met, completedMinutes, outstanding };
}
