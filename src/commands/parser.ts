import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { TaskCategory } from '../tasks/types.js';

/**
 * Command parsing.
 *
 * Everything is matched case-insensitively and tolerantly — a person typing
 * one-handed on a phone should not have to remember exact syntax. Unrecognised
 * input becomes `unknown` and gets a short menu back, never an error.
 */

export type CommandName =
  | 'today'
  | 'what_now'
  | 'done'
  | 'stuck'
  | 'advance'
  | 'snooze'
  | 'rescue'
  | 'add'
  | 'math'
  | 'status'
  | 'help'
  | 'answer'
  | 'unknown';

export interface ParsedCommand {
  name: CommandName;
  /** Everything after the command word. */
  argument: string;
  raw: string;
}

/** Ordered: longer/more specific phrases first so "what now" beats "what". */
const PATTERNS: Array<{ name: CommandName; regex: RegExp }> = [
  { name: 'what_now', regex: /^(what\s*now|whatnow|now|next|wn)\b/i },
  { name: 'today', regex: /^(today|plan|top\s*3|list)\b/i },
  { name: 'done', regex: /^(done|finished|complete[d]?|did it|✅)\b/i },
  { name: 'stuck', regex: /^(stuck|blocked|can'?t start|cant start|help me start)\b/i },
  { name: 'advance', regex: /^(open|ready|ok|got it|it'?s open)\b/i },
  { name: 'snooze', regex: /^(snooze|later|postpone|push|delay)\b/i },
  { name: 'rescue', regex: /^(rescue|overwhelmed|too much|cut it down|sos)\b/i },
  { name: 'add', regex: /^(add|new|capture|remember)\b/i },
  { name: 'math', regex: /^(math|practice|drill)\b/i },
  { name: 'status', regex: /^(status|debug|state)\b/i },
  { name: 'help', regex: /^(help|commands|\?)\b/i },
];

/** Hard cap so a pasted wall of text cannot become a task title. */
export const MAX_COMMAND_LENGTH = 1000;

export function parseCommand(input: string): ParsedCommand {
  const raw = input.slice(0, MAX_COMMAND_LENGTH);
  const trimmed = raw.trim();

  for (const pattern of PATTERNS) {
    const match = pattern.regex.exec(trimmed);
    if (match) {
      return {
        name: pattern.name,
        argument: trimmed.slice(match[0].length).trim(),
        raw: trimmed,
      };
    }
  }
  return { name: 'unknown', argument: trimmed, raw: trimmed };
}

// ---- SNOOZE ---------------------------------------------------------------

export interface SnoozeResult {
  until: DateTime;
  /** How it was understood, echoed back so the user can catch mistakes. */
  interpretation: string;
}

/**
 * Handles "30m", "2h", "4pm", "tomorrow", "until 7", and bare "snooze".
 * Defaults to one hour rather than failing — losing the task is not an option.
 */
export function parseSnooze(argument: string, now: DateTime): SnoozeResult {
  const text = argument.trim().toLowerCase().replace(/^until\s+/, '').trim();

  if (text === '') {
    return { until: now.plus({ hours: 1 }), interpretation: '1 hour' };
  }

  const duration = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(text);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2] ?? 'm';
    if (unit.startsWith('m')) return { until: now.plus({ minutes: amount }), interpretation: `${amount} min` };
    if (unit.startsWith('h')) return { until: now.plus({ hours: amount }), interpretation: `${amount}h` };
    return { until: now.plus({ days: amount }), interpretation: `${amount}d` };
  }

  if (/^tomorrow$/.test(text)) {
    return {
      until: now.plus({ days: 1 }).startOf('day').set({ hour: 9 }),
      interpretation: 'tomorrow morning',
    };
  }
  if (/^(tonight|this evening)$/.test(text)) {
    return { until: now.set({ hour: 19, minute: 0 }), interpretation: 'tonight' };
  }

  // Bare hour like "7" or "4pm": interpret as the next occurrence of that time.
  const bareHour = /^(\d{1,2})\s*(am|pm)?$/.exec(text);
  if (bareHour) {
    const hourRaw = Number(bareHour[1]);
    const meridiem = bareHour[2];
    let hour = hourRaw;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    // No am/pm and an ambiguous hour: assume the sooner future time.
    if (!meridiem && hour <= 12) {
      const morning = now.set({ hour, minute: 0, second: 0, millisecond: 0 });
      const evening = now.set({ hour: hour + 12, minute: 0, second: 0, millisecond: 0 });
      const candidate = morning > now ? morning : evening > now ? evening : morning.plus({ days: 1 });
      return { until: candidate, interpretation: candidate.toFormat('h:mm a') };
    }
    let candidate = now.set({ hour, minute: 0, second: 0, millisecond: 0 });
    if (candidate <= now) candidate = candidate.plus({ days: 1 });
    return { until: candidate, interpretation: candidate.toFormat('h:mm a') };
  }

  const parsed = chrono.parseDate(text, now.toJSDate(), { forwardDate: true });
  if (parsed) {
    const until = DateTime.fromJSDate(parsed, { zone: now.zone });
    if (until > now) return { until, interpretation: until.toFormat('ccc h:mm a') };
  }

  return { until: now.plus({ hours: 1 }), interpretation: '1 hour' };
}

// ---- ADD ------------------------------------------------------------------

export interface ParsedAdd {
  title: string;
  dueAt: DateTime | null;
  estimatedMinutes: number | null;
  category: TaskCategory;
  course: string | null;
  /** Text that was recognised but removed from the title, kept for notes. */
  residue: string | null;
}

const CATEGORY_HINTS: Array<{ category: TaskCategory; regex: RegExp }> = [
  { category: 'academic', regex: /\b(calc|calculus|math|econ|economics|accounting|acct|homework|hw|assignment|quiz|exam|midterm|final|essay|paper|problem set|pset|worksheet|discussion post|lecture|study|class|course)\b/i },
  { category: 'recruiting', regex: /\b(intern(ship)?|apply|application|applications|resume|cover letter|recruit|networking|coffee chat|interview prep|job)\b/i },
  { category: 'career_fixed', regex: /\b(interview|shift|work meeting|onsite|career fair)\b/i },
  { category: 'startup', regex: /\b(startup|dilipilot|outreach|pitch|founder|mvp|customer|landing page)\b/i },
  { category: 'learning', regex: /\b(learn|tutorial|python|course on|read book|practice coding|leetcode)\b/i },
];

/** Common course codes so "calc practice" lands on the right course row. */
const COURSE_HINTS: Array<{ course: string; regex: RegExp }> = [
  { course: 'CALC', regex: /\b(calc|calculus|math\s*1a?)\b/i },
  { course: 'ECON', regex: /\b(econ|economics)\b/i },
  { course: 'ACCT', regex: /\b(acct|accounting)\b/i },
];

export function inferCategory(text: string): TaskCategory {
  for (const hint of CATEGORY_HINTS) {
    if (hint.regex.test(text)) return hint.category;
  }
  return 'personal';
}

export function inferCourse(text: string): string | null {
  for (const hint of COURSE_HINTS) {
    if (hint.regex.test(text)) return hint.course;
  }
  return null;
}

/** "30 min", "45m", "1 hour", "2h" anywhere in the text. */
export function extractDuration(text: string): { minutes: number; matched: string } | null {
  const match = /(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] ?? 'm').toLowerCase();
  const minutes = unit.startsWith('h') ? amount * 60 : amount;
  return { minutes: Math.min(600, minutes), matched: match[0] };
}

/**
 * Parses a free-text ADD. Anything that cannot be understood is preserved:
 * the full original text always reaches the task's notes, so nothing the user
 * typed is ever silently discarded.
 */
export function parseAdd(argument: string, now: DateTime): ParsedAdd {
  const original = argument.trim();
  let working = original;

  const duration = extractDuration(working);
  if (duration) working = working.replace(duration.matched, ' ').trim();

  let dueAt: DateTime | null = null;
  const chronoResults = chrono.parse(working, now.toJSDate(), { forwardDate: true });
  const first = chronoResults[0];
  if (first) {
    const parsedDate = first.start.date();
    const candidate = DateTime.fromJSDate(parsedDate, { zone: now.zone });
    if (candidate.isValid) {
      // A date with no explicit time means end of that day, not midnight —
      // "due Friday" should not be treated as overdue on Friday morning.
      const hasTime = first.start.isCertain('hour');
      dueAt = hasTime ? candidate : candidate.set({ hour: 23, minute: 59 });
      working = `${working.slice(0, first.index)} ${working.slice(first.index + first.text.length)}`.trim();
    }
  }

  const title = working.replace(/\s+/g, ' ').replace(/^[-–—,:;]+|[-–—,:;]+$/g, '').trim();

  return {
    title: title === '' ? original : title,
    dueAt,
    estimatedMinutes: duration?.minutes ?? null,
    category: inferCategory(original),
    course: inferCourse(original),
    // The original is kept whenever parsing changed the text at all.
    residue: title === original ? null : original,
  };
}
