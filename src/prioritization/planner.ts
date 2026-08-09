import { DateTime } from 'luxon';
import type { RuntimeConfig } from '../config/runtimeConfig.js';
import type { Course, Task } from '../tasks/types.js';
import { rankTasks, type EligibilityContext } from './engine.js';
import type { ScoredTask } from './score.js';

export interface PlanOptions extends EligibilityContext {
  courses: Course[];
  /** Free minutes remaining today, used to keep the plan physically possible. */
  freeMinutesToday: number;
}

export interface DailyPlan {
  entries: ScoredTask[];
  /** True when the count was reduced because rescue mode is on. */
  rescue: boolean;
  /** The single task to do first if nothing else happens today. */
  keystone: ScoredTask | null;
  /** Tasks kept out of the plan, with the reason — for logging, not for the user. */
  suppressed: Array<{ task: Task; reason: string }>;
}

/**
 * Composes the day's short list.
 *
 * Two shaping rules beyond raw score, both aimed at the ADHD failure mode
 * rather than at "optimal" scheduling:
 *
 *  1. Category balance — the plan should not be three startup tasks, and it
 *     should not be three separate academic items either, because three big
 *     academic blocks reads as an impossible day and gets ignored wholesale.
 *  2. Physical possibility — if the listed work cannot fit in the free time
 *     that actually exists, the list is trimmed rather than aspirational.
 */
export function buildDailyPlan(tasks: Task[], options: PlanOptions): DailyPlan {
  const limit = options.rescueActive
    ? options.config.rescue_task_count
    : options.config.top_task_count;

  const { ranked, excluded } = rankTasks(tasks, options);

  const chosen: ScoredTask[] = [];
  const perCategory = new Map<string, number>();
  const suppressed: Array<{ task: Task; reason: string }> = excluded.map(({ task, reason }) => ({
    task,
    reason,
  }));

  // Rescue mode is already narrow; extra balancing there only gets in the way.
  const maxAcademic = options.rescueActive ? limit : Math.max(1, limit - 1);
  const maxPerOtherCategory = 1;

  let plannedMinutes = 0;
  const capacity = Math.max(options.freeMinutesToday, 0);

  // Keeps the plan physically possible. The first task is always allowed — a
  // day with almost no free time should still name one thing.
  const fitsCapacity = (candidate: ScoredTask): boolean =>
    chosen.length === 0 ||
    capacity === 0 ||
    plannedMinutes + candidate.task.estimatedMinutes <= capacity;

  const take = (candidate: ScoredTask): void => {
    chosen.push(candidate);
    perCategory.set(candidate.task.category, (perCategory.get(candidate.task.category) ?? 0) + 1);
    plannedMinutes += candidate.task.estimatedMinutes;
  };

  const deferred: ScoredTask[] = [];

  // Pass 1 — balanced selection.
  for (const candidate of ranked) {
    if (chosen.length >= limit) break;
    const category = candidate.task.category;
    const used = perCategory.get(category) ?? 0;
    const cap = category === 'academic' ? maxAcademic : maxPerOtherCategory;

    if (used >= cap) {
      deferred.push(candidate);
      continue;
    }
    if (!fitsCapacity(candidate)) {
      suppressed.push({ task: candidate.task, reason: 'exceeds_free_time' });
      continue;
    }
    take(candidate);
  }

  // Pass 2 — backfill. The category caps are a preference for variety, not a
  // reason to hand back a short list: if every open task is academic, three
  // academic items is the correct plan.
  for (const candidate of deferred) {
    if (chosen.length >= limit) {
      suppressed.push({ task: candidate.task, reason: `category_cap:${candidate.task.category}` });
      continue;
    }
    if (!fitsCapacity(candidate)) {
      suppressed.push({ task: candidate.task, reason: 'exceeds_free_time' });
      continue;
    }
    take(candidate);
  }

  // The keystone is the highest-scoring academic item when one is present,
  // because academic recovery is the dominant objective.
  const keystone =
    chosen.find((entry) => entry.task.category === 'academic') ?? chosen[0] ?? null;

  return { entries: chosen, rescue: options.rescueActive, keystone, suppressed };
}

/**
 * Whether a recruiting block should be offered today. Applications are batched
 * onto configured weekdays rather than nagging daily.
 */
export function isCareerBlockDay(now: DateTime, config: RuntimeConfig): boolean {
  return config.career_block_days.includes(now.weekday);
}
