import { z } from 'zod';

/**
 * Runtime configuration lives in the CONFIG tab of the spreadsheet so the user
 * can change behaviour without touching code or restarting. Every field has a
 * default, and a malformed cell falls back to that default rather than
 * crashing the agent — an unusable agent is worse than a slightly-wrong one.
 */

const bool = (fallback: boolean) =>
  z
    .union([z.boolean(), z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      return ['1', 'true', 'yes', 'on', 'y'].includes(v.trim().toLowerCase());
    });

const num = (fallback: number, min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      const parsed = typeof v === 'number' ? v : Number(v.trim());
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, parsed));
    });

const time = (fallback: string) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      const raw = String(v).trim();
      const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
      if (!match) return fallback;
      const h = Number(match[1]);
      const m = Number(match[2]);
      if (h > 23 || m > 59) return fallback;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    });

const dayList = (fallback: number[]) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      const names: Record<string, number> = {
        mon: 1, monday: 1,
        tue: 2, tues: 2, tuesday: 2,
        wed: 3, weds: 3, wednesday: 3,
        thu: 4, thur: 4, thurs: 4, thursday: 4,
        fri: 5, friday: 5,
        sat: 6, saturday: 6,
        sun: 7, sunday: 7,
      };
      const parts = String(v)
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const out = parts
        .map((p) => (/^\d$/.test(p) ? Number(p) : names[p]))
        .filter((n): n is number => typeof n === 'number' && n >= 1 && n <= 7);
      return out.length > 0 ? out : fallback;
    });

export const runtimeConfigSchema = z.object({
  timezone: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'America/Los_Angeles')),
  morning_time: time('08:00'),
  quiet_hours_start: time('22:30'),
  quiet_hours_end: time('07:30'),
  top_task_count: num(3, 1, 5),

  academic_lock_enabled: bool(true),
  startup_unlock_enabled: bool(true),
  automatic_rescue_enabled: bool(true),
  study_block_calendar_enabled: bool(false),

  max_study_session_minutes: num(50, 10, 120),
  minimum_math_minutes: num(10, 0, 120),
  /** Weekday numbers (1=Mon .. 7=Sun) on which a recruiting block is offered. */
  career_block_days: dayList([2, 4]),
  calendar_lookahead_days: num(14, 1, 60),

  // ---- tuning knobs the spec asks to be configurable ---------------------
  /** Rescue mode shows at most this many tasks. */
  rescue_task_count: num(2, 1, 3),
  /** Auto-rescue trips at or above this many meaningfully-overdue academic tasks. */
  auto_rescue_overdue_academic: num(2, 1, 10),
  /** Auto-rescue trips when a high-importance item is due within this many hours. */
  auto_rescue_deadline_hours: num(24, 1, 168),
  /** Auto-rescue trips at or above this many open tasks on red-risk courses. */
  auto_rescue_red_course_tasks: num(2, 1, 10),
  /** Auto-rescue trips when required minutes exceed free minutes by this ratio. */
  auto_rescue_overload_ratio: num(1.25, 1, 5),

  /** Minutes reserved for context-switching before a recommended task. */
  transition_buffer_minutes: num(5, 0, 30),
  /** WHAT NOW will not propose a task needing more minutes than the free window minus buffer. */
  micro_task_threshold_minutes: num(20, 5, 60),
  /** Daily academic floor that must be met before startup work unlocks. */
  academic_minimum_minutes: num(30, 0, 240),
  /** Weekday (1=Mon..7=Sun) for the weekly school-health message. */
  weekly_health_day: num(7, 1, 7),
  weekly_health_time: time('09:00'),
  /** Do not send a "morning" message later than this — a stale plan is noise. */
  morning_catchup_cutoff: time('12:00'),
  /** Max proactive messages per hour. A safety net against loops. */
  max_proactive_per_hour: num(6, 1, 60),
  /** Max inbound commands handled per minute. */
  max_commands_per_minute: num(20, 1, 120),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = runtimeConfigSchema.parse({});

/**
 * Builds a RuntimeConfig from raw CONFIG-sheet key/value pairs. Unknown keys
 * are ignored; invalid values fall back per-field.
 */
export function parseRuntimeConfig(raw: Record<string, string | number | boolean>): RuntimeConfig {
  const result = runtimeConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  // Should be unreachable — every field is optional with a fallback — but if a
  // future field is added without one, degrade to defaults instead of dying.
  return DEFAULT_RUNTIME_CONFIG;
}

/** The rows written when a CONFIG tab is created for the first time. */
export const CONFIG_SEED_ROWS: Array<[string, string, string]> = [
  ['timezone', 'America/Los_Angeles', 'IANA timezone for all scheduling'],
  ['morning_time', '08:00', 'When the daily Top 3 message is sent'],
  ['quiet_hours_start', '22:30', 'No proactive messages after this time'],
  ['quiet_hours_end', '07:30', 'No proactive messages before this time'],
  ['top_task_count', '3', 'Max tasks in the morning message (1-5)'],
  ['academic_lock_enabled', 'true', 'Hide startup work until academic minimum is met'],
  ['startup_unlock_enabled', 'true', 'Allow startup work once academics are done'],
  ['automatic_rescue_enabled', 'true', 'Auto-cut the plan when the day is overloaded'],
  ['study_block_calendar_enabled', 'false', 'Write study blocks to the Execution Agent calendar'],
  ['max_study_session_minutes', '50', 'Longest single work session'],
  ['minimum_math_minutes', '10', 'Daily math floor, even on rescue days'],
  ['career_block_days', 'tue,thu', 'Weekdays that get a recruiting block'],
  ['calendar_lookahead_days', '14', 'How far ahead to read calendars'],
  ['rescue_task_count', '2', 'Max tasks shown in rescue mode'],
  ['auto_rescue_overdue_academic', '2', 'Overdue academic tasks that trigger rescue'],
  ['auto_rescue_deadline_hours', '24', 'High-impact deadline window that triggers rescue'],
  ['auto_rescue_red_course_tasks', '2', 'Red-course tasks that trigger rescue'],
  ['auto_rescue_overload_ratio', '1.25', 'Required/available time ratio that triggers rescue'],
  ['transition_buffer_minutes', '5', 'Setup time reserved before a recommended task'],
  ['micro_task_threshold_minutes', '20', 'At or below this free time, shrink the action'],
  ['academic_minimum_minutes', '30', 'Daily academic minutes before startup unlocks'],
  ['weekly_health_day', '7', 'Weekday for the school-health message (1=Mon, 7=Sun)'],
  ['weekly_health_time', '09:00', 'Time for the school-health message'],
  ['morning_catchup_cutoff', '12:00', 'Latest time a missed morning message may still be sent'],
  ['max_proactive_per_hour', '6', 'Rate limit on agent-initiated messages'],
  ['max_commands_per_minute', '20', 'Rate limit on inbound commands'],
];
