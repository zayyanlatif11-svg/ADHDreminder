/**
 * The spreadsheet is the human-editable source of truth. Column order is part
 * of that contract: the user may reorder rows freely, but columns are read by
 * position, so these arrays define the sheet layout.
 */

export const TAB = {
  CONFIG: 'CONFIG',
  TASKS: 'TASKS',
  COURSES: 'COURSES',
  DAILY_PLAN: 'DAILY_PLAN',
  EVENT_LOG: 'EVENT_LOG',
  MATH_MASTERY: 'MATH_MASTERY',
} as const;

export type TabName = (typeof TAB)[keyof typeof TAB];

export const CONFIG_COLUMNS = ['key', 'value', 'notes'] as const;

export const TASK_COLUMNS = [
  'id',
  'title',
  'category',
  'course',
  'due_at',
  'estimated_minutes',
  'importance',
  'difficulty',
  'course_risk',
  'priority_override',
  'status',
  'next_action',
  'source',
  'calendar_event_id',
  'recurrence',
  'created_at',
  'completed_at',
  'snoozed_until',
  'last_prompted_at',
  'avoidance_count',
  'notes',
] as const;

export const COURSE_COLUMNS = [
  'course_id',
  'name',
  'calendar_id',
  'current_grade',
  'risk_level',
  'credit_units',
  'daily_minimum_minutes',
  'notes',
] as const;

export const DAILY_PLAN_COLUMNS = [
  'date',
  'rank',
  'task_id',
  'selected_at',
  'status',
  'reason',
  'started_at',
  'completed_at',
] as const;

export const EVENT_LOG_COLUMNS = [
  'timestamp',
  'event_type',
  'message_id',
  'command',
  'task_id',
  'result',
  'details',
] as const;

export const MATH_MASTERY_COLUMNS = [
  'concept',
  'mastery',
  'attempts',
  'correct',
  'last_practiced',
  'next_review',
  'notes',
] as const;

export const TAB_COLUMNS: Record<TabName, readonly string[]> = {
  [TAB.CONFIG]: CONFIG_COLUMNS,
  [TAB.TASKS]: TASK_COLUMNS,
  [TAB.COURSES]: COURSE_COLUMNS,
  [TAB.DAILY_PLAN]: DAILY_PLAN_COLUMNS,
  [TAB.EVENT_LOG]: EVENT_LOG_COLUMNS,
  [TAB.MATH_MASTERY]: MATH_MASTERY_COLUMNS,
};

/** A1 range covering every defined column of a tab, from row 1. */
export function fullRange(tab: TabName): string {
  const width = TAB_COLUMNS[tab].length;
  return `${tab}!A1:${columnLetter(width)}`;
}

export function columnLetter(index1Based: number): string {
  let n = index1Based;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Maps a header row to column indices, tolerating reordering and extra columns. */
export function headerIndex(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  headers.forEach((header, index) => {
    const key = header.trim().toLowerCase().replace(/\s+/g, '_');
    if (key !== '' && !(key in map)) map[key] = index;
  });
  return map;
}
