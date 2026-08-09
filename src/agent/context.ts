import { DateTime } from 'luxon';
import type { RuntimeConfig } from '../config/runtimeConfig.js';
import type { CalendarEvent } from '../calendar/types.js';
import type { Course, Task } from '../tasks/types.js';
import type { TimeWindow } from '../utils/time.js';

/**
 * A single consistent snapshot of "the world right now".
 *
 * Every command builds one of these once and reads from it, so a single reply
 * cannot be internally inconsistent (e.g. computing free time against one
 * moment and deadlines against another).
 */
export interface AgentContext {
  now: DateTime;
  zone: string;
  config: RuntimeConfig;
  tasks: Task[];
  courses: Course[];
  events: CalendarEvent[];
  /** Free windows for the remainder of today. */
  freeWindows: TimeWindow[];
  freeMinutesToday: number;
  rescueActive: boolean;
  academicMinimumMet: boolean;
  academicCompletedMinutes: number;
}

export function todayKey(context: AgentContext): string {
  return context.now.toFormat('yyyy-LL-dd');
}

export function tasksById(context: AgentContext): Map<string, Task> {
  return new Map(context.tasks.map((task) => [task.id, task]));
}

export function coursesById(context: AgentContext): Map<string, Course> {
  return new Map(context.courses.map((course) => [course.courseId, course]));
}

export function hardDeadlineToday(context: AgentContext): boolean {
  return context.tasks.some((task) => {
    if (!task.dueAt || task.status === 'completed' || task.status === 'cancelled') return false;
    const due = DateTime.fromISO(task.dueAt, { zone: context.zone });
    return due.isValid && due.hasSame(context.now, 'day') && task.importance >= 4;
  });
}
