import type { RuntimeConfig } from '../config/runtimeConfig.js';
import type { Task } from '../tasks/types.js';
import type { ScoredTask } from './score.js';

export interface FitContext {
  /** Minutes actually free right now. */
  availableMinutes: number;
  config: RuntimeConfig;
}

export interface FitResult {
  fits: boolean;
  /** Minutes the task would realistically consume, buffer included. */
  requiredMinutes: number;
  /** Set when the task only fits because its action was shrunk. */
  shrunkTo?: number;
}

/**
 * Does this task fit the window the user actually has?
 *
 * The buffer matters more than it looks: with ADHD, the gap between "class ends"
 * and "actually working" is real, and pretending a 42-minute gap holds 42
 * minutes of work is how a plan stops being believable.
 */
export function evaluateFit(task: Task, context: FitContext): FitResult {
  const buffer = context.config.transition_buffer_minutes;
  const usable = context.availableMinutes - buffer;
  const required = task.estimatedMinutes + buffer;

  if (usable <= 0) return { fits: false, requiredMinutes: required };
  if (task.estimatedMinutes <= usable) return { fits: true, requiredMinutes: required };

  // Long tasks can still be started in a short window — but only if a real
  // chunk of work fits. Below the micro threshold we shrink instead.
  const micro = context.config.micro_task_threshold_minutes;
  if (usable >= micro && task.estimatedMinutes > usable) {
    return { fits: true, requiredMinutes: usable + buffer, shrunkTo: usable };
  }
  return { fits: false, requiredMinutes: required };
}

export interface SelectionOptions extends FitContext {
  /** Excludes tasks already chosen in this pass. */
  exclude?: Set<string>;
}

export interface Selection {
  choice: ScoredTask;
  fit: FitResult;
}

/**
 * Walks the ranked list and returns the highest-value task that genuinely fits.
 * This is the heart of WHAT NOW: never offer a 60-minute task for an 18-minute gap.
 */
export function selectForWindow(
  ranked: ScoredTask[],
  options: SelectionOptions,
): Selection | null {
  const exclude = options.exclude ?? new Set<string>();
  for (const candidate of ranked) {
    if (exclude.has(candidate.task.id)) continue;
    const fit = evaluateFit(candidate.task, options);
    if (fit.fits) return { choice: candidate, fit };
  }
  return null;
}

/**
 * When only a few minutes exist, the honest move is to shrink the ask rather
 * than skip the session. Returns the phrasing used in WHAT NOW.
 */
export function shrinkAction(task: Task, minutes: number): string {
  const base = task.nextAction?.trim();
  if (minutes <= 5) {
    return base ? `Just start: ${lowerFirst(base)}` : `Open ${task.title} and read the first line.`;
  }
  if (minutes <= 15) {
    return base ? `${base} — just the first piece.` : `Spend ${minutes} min on ${task.title}.`;
  }
  return base ?? `Work on ${task.title} for ${minutes} min.`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
