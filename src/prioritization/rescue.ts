import { DateTime } from 'luxon';
import type { RuntimeConfig } from '../config/runtimeConfig.js';
import type { Course, Task } from '../tasks/types.js';
import { isOpen } from '../tasks/types.js';
import { isSnoozed } from './engine.js';

export interface RescueSignals {
  overdueAcademic: number;
  imminentHighImpact: number;
  redCourseTasks: number;
  /** Ratio of required work minutes to genuinely free minutes today. */
  loadRatio: number;
}

export interface RescueAssessment {
  shouldActivate: boolean;
  signals: RescueSignals;
  triggers: string[];
}

export interface AssessOptions {
  now: DateTime;
  zone: string;
  config: RuntimeConfig;
  courses: Course[];
  freeMinutesToday: number;
}

/**
 * Decides whether today is overloaded enough to cut the plan automatically.
 *
 * Every threshold is configurable via the CONFIG tab, because "overwhelmed" is
 * personal and needs tuning against real weeks.
 */
export function assessAutoRescue(tasks: Task[], options: AssessOptions): RescueAssessment {
  const { now, zone, config, courses } = options;
  const riskByCourse = new Map(courses.map((course) => [course.courseId, course.riskLevel]));

  const active = tasks
    .filter(isOpen)
    .filter((task) => !isSnoozed(task, now, zone));

  const overdueAcademic = active.filter((task) => {
    if (task.category !== 'academic' || !task.dueAt) return false;
    const due = DateTime.fromISO(task.dueAt, { zone });
    // "Meaningful" = actually mattered. A trivial missed item is not a crisis.
    return due.isValid && due < now && task.importance >= 3;
  }).length;

  const imminentHighImpact = active.filter((task) => {
    if (!task.dueAt || task.importance < 4) return false;
    const due = DateTime.fromISO(task.dueAt, { zone });
    if (!due.isValid) return false;
    const hours = due.diff(now, 'hours').hours;
    return hours >= 0 && hours <= config.auto_rescue_deadline_hours;
  }).length;

  const redCourseTasks = active.filter((task) => {
    const risk = task.courseRisk ?? (task.course ? riskByCourse.get(task.course) : undefined);
    return risk === 'red';
  }).length;

  // Only work that must happen in the next 48h counts toward overload; the
  // whole backlog is not "today's required work".
  const requiredMinutes = active
    .filter((task) => {
      if (!task.dueAt) return false;
      const due = DateTime.fromISO(task.dueAt, { zone });
      if (!due.isValid) return false;
      const hours = due.diff(now, 'hours').hours;
      return hours <= 48;
    })
    .reduce((sum, task) => sum + task.estimatedMinutes, 0);

  const loadRatio =
    options.freeMinutesToday > 0
      ? requiredMinutes / options.freeMinutesToday
      : requiredMinutes > 0
        ? Number.POSITIVE_INFINITY
        : 0;

  const signals: RescueSignals = {
    overdueAcademic,
    imminentHighImpact,
    redCourseTasks,
    loadRatio,
  };

  const triggers: string[] = [];
  if (overdueAcademic >= config.auto_rescue_overdue_academic) triggers.push('overdue_academic');
  if (imminentHighImpact >= 1) triggers.push('imminent_deadline');
  if (redCourseTasks >= config.auto_rescue_red_course_tasks) triggers.push('red_course_load');
  if (loadRatio >= config.auto_rescue_overload_ratio) triggers.push('overloaded_day');

  return {
    shouldActivate: config.automatic_rescue_enabled && triggers.length > 0,
    signals,
    triggers,
  };
}

/** Rescue mode lasts for the remainder of the local day. */
export function rescueExpiry(now: DateTime): string {
  return now.endOf('day').toISO() ?? now.plus({ hours: 6 }).toISO() ?? '';
}

export function isRescueActive(rescueUntil: string | null, now: DateTime): boolean {
  if (!rescueUntil) return false;
  const until = DateTime.fromISO(rescueUntil);
  return until.isValid && until > now;
}
