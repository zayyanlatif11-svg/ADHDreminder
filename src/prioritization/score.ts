import { DateTime } from 'luxon';
import { CATEGORY_RANK, type Course, type Task } from '../tasks/types.js';

/**
 * Deterministic scoring. No LLM is involved in deciding what matters — the
 * ordering must be reproducible, testable, and explainable to the user.
 *
 * Higher score = do sooner.
 */

export interface ScoreContext {
  now: DateTime;
  zone: string;
  coursesById: Map<string, Course>;
}

export interface ScoredTask {
  task: Task;
  score: number;
  /** Human-readable contributions, surfaced in DAILY_PLAN.reason and logs. */
  factors: Record<string, number>;
  reason: string;
}

/** Category is the backbone: academics outrank everything by default. */
const CATEGORY_POINTS: Record<number, number> = {
  1: 100, // academic
  2: 78,  // career_fixed
  3: 55,  // recruiting
  4: 38,  // startup
  5: 22,  // learning
  6: 10,  // personal
};

export function categoryScore(task: Task): number {
  return CATEGORY_POINTS[CATEGORY_RANK[task.category]] ?? 10;
}

/**
 * Deadline pressure. The curve is steep near the deadline so that "due
 * tomorrow" reliably beats "due next week" regardless of category ties.
 */
export function urgencyScore(task: Task, now: DateTime, zone: string): number {
  if (!task.dueAt) return 0;
  const due = DateTime.fromISO(task.dueAt, { zone });
  if (!due.isValid) return 0;

  const hours = due.diff(now, 'hours').hours;

  if (hours < 0) {
    // Overdue matters, but an ancient overdue item should not permanently
    // dominate the plan — that is how backlogs become paralysing.
    const overdueDays = Math.min(14, Math.abs(hours) / 24);
    return 85 - Math.min(25, overdueDays * 2);
  }
  if (hours <= 6) return 95;
  if (hours <= 24) return 80;
  if (hours <= 48) return 60;
  if (hours <= 24 * 7) return 40 - (hours - 48) * (15 / (24 * 5));
  return Math.max(0, 15 - (hours - 24 * 7) / 48);
}

/** Importance (1–5) scaled so a 5 is worth a meaningful but not decisive jump. */
export function importanceScore(task: Task): number {
  return (task.importance - 3) * 12;
}

/** Red/yellow courses get a boost so at-risk classes surface first. */
export function riskScore(task: Task, coursesById: Map<string, Course>): number {
  const risk =
    task.courseRisk ?? (task.course ? coursesById.get(task.course)?.riskLevel : undefined);
  if (risk === 'red') return 30;
  if (risk === 'yellow') return 15;
  return 0;
}

/**
 * Repeated avoidance nudges a task upward rather than letting it sink forever.
 * Capped, because an avoided task is often avoided for a good reason and the
 * right fix is a smaller next action (STUCK), not infinite escalation.
 */
export function avoidanceScore(task: Task): number {
  return Math.min(20, task.avoidanceCount * 5);
}

/** Multi-session work needs to start early, so it gets a small head start. */
export function sizeScore(task: Task): number {
  if (task.estimatedMinutes >= 120) return 10;
  if (task.estimatedMinutes >= 60) return 5;
  return 0;
}

export function overrideScore(task: Task): number {
  return (task.priorityOverride ?? 0) * 10;
}

function describe(factors: Record<string, number>, task: Task): string {
  const parts: string[] = [task.category];
  if (factors['urgency'] !== undefined && factors['urgency'] >= 60) parts.push('deadline soon');
  if (factors['urgency'] !== undefined && factors['urgency'] > 0 && factors['urgency'] < 60) {
    parts.push('has deadline');
  }
  if ((factors['risk'] ?? 0) >= 30) parts.push('red course');
  else if ((factors['risk'] ?? 0) > 0) parts.push('yellow course');
  if ((factors['avoidance'] ?? 0) > 0) parts.push('previously skipped');
  if ((factors['override'] ?? 0) !== 0) parts.push('manual override');
  return parts.join(', ');
}

export function scoreTask(task: Task, context: ScoreContext): ScoredTask {
  const factors: Record<string, number> = {
    category: categoryScore(task),
    urgency: urgencyScore(task, context.now, context.zone),
    importance: importanceScore(task),
    risk: riskScore(task, context.coursesById),
    avoidance: avoidanceScore(task),
    size: sizeScore(task),
    override: overrideScore(task),
  };
  const score = Object.values(factors).reduce((sum, value) => sum + value, 0);
  return { task, score, factors, reason: describe(factors, task) };
}

export function scoreAll(tasks: Task[], context: ScoreContext): ScoredTask[] {
  return tasks
    .map((task) => scoreTask(task, context))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable, explainable tiebreak: earlier deadline, then shorter task
      // (easier to start), then id for full determinism.
      const dueA = a.task.dueAt ?? '9999';
      const dueB = b.task.dueAt ?? '9999';
      if (dueA !== dueB) return dueA.localeCompare(dueB);
      if (a.task.estimatedMinutes !== b.task.estimatedMinutes) {
        return a.task.estimatedMinutes - b.task.estimatedMinutes;
      }
      return a.task.id.localeCompare(b.task.id);
    });
}
