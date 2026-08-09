import { DateTime } from 'luxon';
import type { Task } from '../tasks/types.js';
import { isOpen } from '../tasks/types.js';

/**
 * Missed-task handling.
 *
 * The anti-goal is the snowball: yesterday's undone list landing on top of
 * today's, every day, until the message is unreadable and the user stops
 * opening it. So a missed task is *evaluated*, not automatically re-promoted.
 */

export type RolloverAction =
  | 'promote'        // still required and now urgent — it belongs in today's plan
  | 'keep_backlog'   // still real, but does not need to be today's headline
  | 'reschedule'     // aspirational/recurring — push out rather than pile up
  | 'expire';        // the deadline passed and the work no longer has a point

export interface RolloverDecision {
  task: Task;
  action: RolloverAction;
  reason: string;
  /** Set when action is `reschedule`. */
  snoozeUntil?: string;
}

export interface RolloverOptions {
  now: DateTime;
  zone: string;
  /** Tasks that appeared in yesterday's plan but were not completed. */
  missedTaskIds: Set<string>;
}

/**
 * Decides what happens to each open task that was planned but not completed.
 */
export function evaluateRollover(tasks: Task[], options: RolloverOptions): RolloverDecision[] {
  const { now, zone, missedTaskIds } = options;
  const decisions: RolloverDecision[] = [];

  for (const task of tasks) {
    if (!isOpen(task)) continue;
    if (!missedTaskIds.has(task.id)) continue;

    const due = task.dueAt ? DateTime.fromISO(task.dueAt, { zone }) : null;
    const hoursToDue = due?.isValid ? due.diff(now, 'hours').hours : null;

    // 1. Deadline passed on something that only mattered before the deadline.
    if (hoursToDue !== null && hoursToDue < -48 && task.importance <= 2) {
      decisions.push({
        task,
        action: 'expire',
        reason: 'deadline passed and low impact — closing it out',
      });
      continue;
    }

    // 2. Still required and now genuinely urgent.
    if (hoursToDue !== null && hoursToDue <= 48) {
      decisions.push({
        task,
        action: 'promote',
        reason: hoursToDue < 0 ? 'overdue and still required' : 'deadline within 48h',
      });
      continue;
    }

    // 3. Optional/interesting work that keeps being skipped. Pushing it out
    //    keeps the list honest instead of pretending today is the day.
    const aspirational =
      task.category === 'learning' ||
      task.category === 'personal' ||
      (task.category === 'startup' && task.importance <= 3);

    if (aspirational && task.avoidanceCount >= 2) {
      decisions.push({
        task,
        action: 'reschedule',
        reason: 'repeatedly skipped and not deadline-driven — moved out of the way',
        snoozeUntil: now.plus({ days: 3 }).startOf('day').set({ hour: 9 }).toISO() ?? undefined,
      });
      continue;
    }

    // 4. Everything else stays available but does not claim a Top-3 slot.
    decisions.push({
      task,
      action: 'keep_backlog',
      reason: 'still open, no deadline pressure yet',
    });
  }

  return decisions;
}

/**
 * The patch to apply for a decision. Kept separate from the decision so the
 * logic stays pure and testable.
 */
export function rolloverPatch(decision: RolloverDecision): Partial<Task> | null {
  switch (decision.action) {
    case 'expire':
      return { status: 'cancelled', notes: appendNote(decision.task.notes, decision.reason) };
    case 'reschedule':
      return {
        status: 'snoozed',
        snoozedUntil: decision.snoozeUntil ?? null,
        avoidanceCount: decision.task.avoidanceCount + 1,
      };
    case 'promote':
      return { status: 'ready', avoidanceCount: decision.task.avoidanceCount + 1 };
    case 'keep_backlog':
      return { avoidanceCount: decision.task.avoidanceCount + 1 };
    default:
      return null;
  }
}

function appendNote(existing: string | null, addition: string): string {
  const stamp = `[auto] ${addition}`;
  return existing ? `${existing}\n${stamp}` : stamp;
}

/**
 * Guard used by the morning message: only tasks the rollover pass promoted are
 * even considered for a Top-3 slot from yesterday's leftovers.
 */
export function promotedIds(decisions: RolloverDecision[]): Set<string> {
  return new Set(
    decisions.filter((decision) => decision.action === 'promote').map((d) => d.task.id),
  );
}
