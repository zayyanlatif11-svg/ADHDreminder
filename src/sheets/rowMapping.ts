import {
  RISK_LEVELS,
  TASK_CATEGORIES,
  TASK_STATUSES,
  type Course,
  type DailyPlanEntry,
  type EventLogEntry,
  type MathMasteryRow,
  type RiskLevel,
  type Task,
  type TaskCategory,
  type TaskStatus,
} from '../tasks/types.js';
import {
  COURSE_COLUMNS,
  DAILY_PLAN_COLUMNS,
  EVENT_LOG_COLUMNS,
  MATH_MASTERY_COLUMNS,
  TASK_COLUMNS,
  headerIndex,
} from './schema.js';

/**
 * Sheet cells are strings typed by a human. Every parse here is forgiving:
 * an unrecognised category becomes `personal` rather than throwing, because a
 * typo in one row must not stop the morning message from going out.
 */

type Cell = string | number | boolean | null | undefined;
export type Row = Cell[];

function str(row: Row, index: number | undefined): string | null {
  if (index === undefined) return null;
  const value = row[index];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * Extracts a number from a cell a human typed ("35", "35 min", "~35").
 * Returns null when there is no digit at all, so callers use their default
 * rather than silently reading a typo as zero.
 */
function numeric(row: Row, index: number | undefined): number | null {
  const raw = str(row, index);
  if (raw === null) return null;
  const stripped = raw.replace(/[^\d.-]/g, '');
  if (!/\d/.test(stripped)) return null;
  const parsed = Number(stripped);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(row: Row, index: number | undefined, fallback: number): number {
  const parsed = numeric(row, index);
  return parsed === null ? fallback : Math.round(parsed);
}

function float(row: Row, index: number | undefined, fallback: number): number {
  return numeric(row, index) ?? fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function optionalInt(row: Row, index: number | undefined): number | null {
  return numeric(row, index);
}

function enumOr<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === null) return fallback;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

function enumOrNull<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : null;
}

/**
 * Dates may be ISO, "2026-08-12 14:00", or a US-style date the user typed.
 * Anything unparseable becomes null (= no deadline) rather than a fake one —
 * inventing a deadline is worse than having none.
 */
export function parseSheetDate(value: string | null): string | null {
  if (value === null) return null;
  const raw = value.trim();
  if (raw === '') return null;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  // "2026-08-12 14:00" — normalise the space separator then retry.
  const spaced = new Date(raw.replace(' ', 'T'));
  if (!Number.isNaN(spaced.getTime())) return spaced.toISOString();

  return null;
}

export function rowToTask(row: Row, headers: string[], rowNumber: number): Task | null {
  const h = headerIndex(headers.length > 0 ? headers : [...TASK_COLUMNS]);
  const id = str(row, h['id']);
  const title = str(row, h['title']);
  // A row with neither id nor title is a blank/spacer row, not a broken task.
  if (id === null && title === null) return null;

  return {
    id: id ?? `row-${rowNumber}`,
    title: title ?? '(untitled)',
    category: enumOr<TaskCategory>(str(row, h['category']), TASK_CATEGORIES, 'personal'),
    course: str(row, h['course']),
    dueAt: parseSheetDate(str(row, h['due_at'])),
    estimatedMinutes: clamp(int(row, h['estimated_minutes'], 30), 1, 600),
    importance: clamp(int(row, h['importance'], 3), 1, 5),
    difficulty: clamp(int(row, h['difficulty'], 3), 1, 5),
    courseRisk: enumOrNull<RiskLevel>(str(row, h['course_risk']), RISK_LEVELS),
    priorityOverride: optionalInt(row, h['priority_override']),
    status: enumOr<TaskStatus>(str(row, h['status']), TASK_STATUSES, 'ready'),
    nextAction: str(row, h['next_action']),
    source: str(row, h['source']) ?? 'manual',
    calendarEventId: str(row, h['calendar_event_id']),
    recurrence: str(row, h['recurrence']),
    createdAt: parseSheetDate(str(row, h['created_at'])),
    completedAt: parseSheetDate(str(row, h['completed_at'])),
    snoozedUntil: parseSheetDate(str(row, h['snoozed_until'])),
    lastPromptedAt: parseSheetDate(str(row, h['last_prompted_at'])),
    avoidanceCount: Math.max(0, int(row, h['avoidance_count'], 0)),
    notes: str(row, h['notes']),
    rowNumber,
  };
}

export function taskToRow(task: Task): Row {
  const map: Record<string, Cell> = {
    id: task.id,
    title: task.title,
    category: task.category,
    course: task.course ?? '',
    due_at: task.dueAt ?? '',
    estimated_minutes: task.estimatedMinutes,
    importance: task.importance,
    difficulty: task.difficulty,
    course_risk: task.courseRisk ?? '',
    priority_override: task.priorityOverride ?? '',
    status: task.status,
    next_action: task.nextAction ?? '',
    source: task.source,
    calendar_event_id: task.calendarEventId ?? '',
    recurrence: task.recurrence ?? '',
    created_at: task.createdAt ?? '',
    completed_at: task.completedAt ?? '',
    snoozed_until: task.snoozedUntil ?? '',
    last_prompted_at: task.lastPromptedAt ?? '',
    avoidance_count: task.avoidanceCount,
    notes: task.notes ?? '',
  };
  return TASK_COLUMNS.map((column) => map[column] ?? '');
}

export function rowToCourse(row: Row, headers: string[], rowNumber: number): Course | null {
  const h = headerIndex(headers.length > 0 ? headers : [...COURSE_COLUMNS]);
  const courseId = str(row, h['course_id']);
  const name = str(row, h['name']);
  if (courseId === null && name === null) return null;

  return {
    courseId: courseId ?? name ?? `course-${rowNumber}`,
    name: name ?? courseId ?? '(unnamed course)',
    calendarId: str(row, h['calendar_id']),
    currentGrade: str(row, h['current_grade']),
    riskLevel: enumOr<RiskLevel>(str(row, h['risk_level']), RISK_LEVELS, 'green'),
    creditUnits: optionalInt(row, h['credit_units']),
    dailyMinimumMinutes: clamp(int(row, h['daily_minimum_minutes'], 0), 0, 480),
    notes: str(row, h['notes']),
    rowNumber,
  };
}

export function courseToRow(course: Course): Row {
  const map: Record<string, Cell> = {
    course_id: course.courseId,
    name: course.name,
    calendar_id: course.calendarId ?? '',
    current_grade: course.currentGrade ?? '',
    risk_level: course.riskLevel,
    credit_units: course.creditUnits ?? '',
    daily_minimum_minutes: course.dailyMinimumMinutes,
    notes: course.notes ?? '',
  };
  return COURSE_COLUMNS.map((column) => map[column] ?? '');
}

export function rowToDailyPlan(
  row: Row,
  headers: string[],
  rowNumber: number,
): DailyPlanEntry | null {
  const h = headerIndex(headers.length > 0 ? headers : [...DAILY_PLAN_COLUMNS]);
  const date = str(row, h['date']);
  const taskId = str(row, h['task_id']);
  if (date === null || taskId === null) return null;

  const status = enumOr(str(row, h['status']), ['planned', 'started', 'completed', 'dropped'] as const, 'planned');
  return {
    date,
    rank: int(row, h['rank'], 1),
    taskId,
    selectedAt: str(row, h['selected_at']) ?? '',
    status,
    reason: str(row, h['reason']) ?? '',
    startedAt: str(row, h['started_at']),
    completedAt: str(row, h['completed_at']),
    rowNumber,
  };
}

export function dailyPlanToRow(entry: DailyPlanEntry): Row {
  const map: Record<string, Cell> = {
    date: entry.date,
    rank: entry.rank,
    task_id: entry.taskId,
    selected_at: entry.selectedAt,
    status: entry.status,
    reason: entry.reason,
    started_at: entry.startedAt ?? '',
    completed_at: entry.completedAt ?? '',
  };
  return DAILY_PLAN_COLUMNS.map((column) => map[column] ?? '');
}

export function eventLogToRow(entry: EventLogEntry): Row {
  const map: Record<string, Cell> = {
    timestamp: entry.timestamp,
    event_type: entry.eventType,
    message_id: entry.messageId ?? '',
    command: entry.command ?? '',
    task_id: entry.taskId ?? '',
    result: entry.result ?? '',
    details: entry.details ?? '',
  };
  return EVENT_LOG_COLUMNS.map((column) => map[column] ?? '');
}

export function rowToMastery(
  row: Row,
  headers: string[],
  rowNumber: number,
): MathMasteryRow | null {
  const h = headerIndex(headers.length > 0 ? headers : [...MATH_MASTERY_COLUMNS]);
  const concept = str(row, h['concept']);
  if (concept === null) return null;

  return {
    concept,
    mastery: clamp(float(row, h['mastery'], 0), 0, 1),
    attempts: Math.max(0, int(row, h['attempts'], 0)),
    correct: Math.max(0, int(row, h['correct'], 0)),
    lastPracticed: str(row, h['last_practiced']),
    nextReview: str(row, h['next_review']),
    notes: str(row, h['notes']),
    rowNumber,
  };
}

export function masteryToRow(mastery: MathMasteryRow): Row {
  const map: Record<string, Cell> = {
    concept: mastery.concept,
    mastery: Number(mastery.mastery.toFixed(3)),
    attempts: mastery.attempts,
    correct: mastery.correct,
    last_practiced: mastery.lastPracticed ?? '',
    next_review: mastery.nextReview ?? '',
    notes: mastery.notes ?? '',
  };
  return MATH_MASTERY_COLUMNS.map((column) => map[column] ?? '');
}
