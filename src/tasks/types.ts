/**
 * Domain types. These are the shapes the whole application reasons about —
 * no adapter payload (BlueBubbles, Google, Sheets rows) leaks past its own module.
 */

export const TASK_CATEGORIES = [
  'academic',
  'career_fixed',
  'recruiting',
  'startup',
  'learning',
  'personal',
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_STATUSES = [
  'inbox',
  'ready',
  'active',
  'snoozed',
  'completed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RISK_LEVELS = ['green', 'yellow', 'red'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Lower number = higher priority. Drives the base of the score. */
export const CATEGORY_RANK: Record<TaskCategory, number> = {
  academic: 1,
  career_fixed: 2,
  recruiting: 3,
  startup: 4,
  learning: 5,
  personal: 6,
};

export interface Task {
  id: string;
  title: string;
  category: TaskCategory;
  course: string | null;
  /** ISO string in the configured timezone, or null when there is no deadline. */
  dueAt: string | null;
  estimatedMinutes: number;
  /** 1–5. How much this matters academically/professionally. */
  importance: number;
  /** 1–5. How hard it feels to start — feeds the STUCK reduction. */
  difficulty: number;
  courseRisk: RiskLevel | null;
  /** Manual thumb on the scale from the Sheet. Positive = do sooner. */
  priorityOverride: number | null;
  status: TaskStatus;
  /** The concrete first physical action. This is what actually gets sent. */
  nextAction: string | null;
  source: string;
  calendarEventId: string | null;
  recurrence: string | null;
  createdAt: string | null;
  completedAt: string | null;
  snoozedUntil: string | null;
  lastPromptedAt: string | null;
  /** Incremented when a task is offered and then snoozed/skipped. */
  avoidanceCount: number;
  notes: string | null;
  /** Row number in the Sheet, used for targeted updates. Not part of the model. */
  rowNumber?: number;
}

export interface Course {
  courseId: string;
  name: string;
  calendarId: string | null;
  currentGrade: string | null;
  riskLevel: RiskLevel;
  creditUnits: number | null;
  dailyMinimumMinutes: number;
  notes: string | null;
  rowNumber?: number;
}

export interface DailyPlanEntry {
  date: string;
  rank: number;
  taskId: string;
  selectedAt: string;
  status: 'planned' | 'started' | 'completed' | 'dropped';
  reason: string;
  startedAt: string | null;
  completedAt: string | null;
  rowNumber?: number;
}

export interface EventLogEntry {
  timestamp: string;
  eventType: string;
  messageId: string | null;
  command: string | null;
  taskId: string | null;
  result: string | null;
  details: string | null;
}

export interface MathMasteryRow {
  concept: string;
  /** 0..1 */
  mastery: number;
  attempts: number;
  correct: number;
  lastPracticed: string | null;
  nextReview: string | null;
  notes: string | null;
  rowNumber?: number;
}

export function isActionable(status: TaskStatus): boolean {
  return status === 'inbox' || status === 'ready' || status === 'active';
}

export function isOpen(task: Task): boolean {
  return task.status !== 'completed' && task.status !== 'cancelled';
}
