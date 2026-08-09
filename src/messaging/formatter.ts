import { DateTime } from 'luxon';
import type { Course, Task } from '../tasks/types.js';
import type { ScoredTask } from '../prioritization/score.js';
import { humanDuration, relativeDueLabel, weekdayHeader } from '../utils/time.js';

/**
 * Message construction.
 *
 * Rules encoded here, not left to judgement:
 *  - no guilt, no counts of what was missed, no motivational speeches
 *  - short enough to read without scrolling
 *  - every item ends in a physical first action
 *  - the backlog is never dumped
 */

/** Titles are trimmed so a rambling sheet entry cannot blow up a message. */
const MAX_TITLE = 60;
const MAX_ACTION = 90;

export function shortTitle(text: string, limit = MAX_TITLE): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
}

/** The label shown on the left of a plan line: course code, else category. */
export function taskLabel(task: Task, courses: Course[] = []): string {
  if (task.course) {
    const course = courses.find((c) => c.courseId === task.course);
    return (course?.courseId ?? task.course).toUpperCase();
  }
  switch (task.category) {
    case 'career_fixed':
      return 'WORK';
    case 'recruiting':
      return 'CAREER';
    case 'startup':
      return 'STARTUP';
    case 'learning':
      return 'LEARN';
    case 'academic':
      return 'SCHOOL';
    default:
      return 'PERSONAL';
  }
}

/**
 * The right-hand side of a plan line: a duration, or a deadline when the
 * deadline is the reason it is on the list.
 */
export function taskMeta(task: Task, now: DateTime, zone: string): string {
  if (task.dueAt) {
    const due = DateTime.fromISO(task.dueAt, { zone });
    if (due.isValid) {
      const hours = due.diff(now, 'hours').hours;
      if (hours <= 48) return relativeDueLabel(due, now);
    }
  }
  return humanDuration(task.estimatedMinutes);
}

/** The concrete physical action. Falls back to something startable. */
export function startLine(task: Task): string {
  const action = task.nextAction?.trim();
  if (action && action.length > 0) return shortTitle(action, MAX_ACTION);
  return `Open ${shortTitle(task.title, 40)}.`;
}

export interface MorningMessageInput {
  now: DateTime;
  zone: string;
  entries: ScoredTask[];
  keystone: ScoredTask | null;
  courses: Course[];
  rescue: boolean;
  /** Set when rescue mode was entered automatically. */
  autoRescue?: boolean;
}

export function formatMorningMessage(input: MorningMessageInput): string {
  const { now, zone, entries, courses } = input;

  if (entries.length === 0) {
    return [
      `${weekdayHeader(now)} — nothing scheduled.`,
      '',
      'No must-dos today.',
      'Reply ADD to capture something, or MATH for 10 minutes of practice.',
    ].join('\n');
  }

  const lines: string[] = [];

  if (input.rescue) {
    lines.push('RESCUE MODE');
    if (input.autoRescue) lines.push('Today is overloaded, so I cut the plan down.');
    lines.push('Ignore everything except:');
  } else {
    lines.push(`${weekdayHeader(now)} — TOP ${entries.length}`);
  }
  lines.push('');

  entries.forEach((entry, index) => {
    const task = entry.task;
    lines.push(`${index + 1}. ${taskLabel(task, courses)} — ${taskMeta(task, now, zone)}`);
    lines.push(shortTitle(task.title));
    lines.push(`Start: ${startLine(task)}`);
    lines.push('');
  });

  if (input.keystone) {
    const label = taskLabel(input.keystone.task, courses);
    lines.push(
      input.rescue
        ? `Start with ${titleCase(label)}.`
        : `If you only do one thing: ${titleCase(label)}.`,
    );
  }

  lines.push('');
  lines.push('Reply WHAT NOW, STUCK, DONE, SNOOZE, or RESCUE.');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

export interface WhatNowInput {
  task: Task;
  courses: Course[];
  availableMinutes: number;
  /** Name of the next fixed commitment, when one bounds the window. */
  nextEventTitle?: string | null;
  /** Set when the action was shrunk to fit the window. */
  shrunkTo?: number;
  actionOverride?: string;
}

export function formatWhatNow(input: WhatNowInput): string {
  const { task, availableMinutes } = input;
  const lines: string[] = [];

  if (input.nextEventTitle) {
    lines.push(
      `You have ${humanDuration(availableMinutes)} before ${shortTitle(input.nextEventTitle, 30)}.`,
    );
  } else {
    lines.push(`You have about ${humanDuration(availableMinutes)}.`);
  }
  lines.push('');
  lines.push('Do:');
  lines.push(shortTitle(task.title));
  lines.push('');
  lines.push(`Start: ${input.actionOverride ?? startLine(task)}`);

  if (input.shrunkTo !== undefined) {
    lines.push('');
    lines.push(`Just ${humanDuration(input.shrunkTo)}. Stop when the timer ends.`);
  }
  return lines.join('\n');
}

export function formatNoTimeAvailable(nextFreeAt: DateTime | null, zone: string): string {
  if (!nextFreeAt) {
    return ['You are booked for the rest of the day.', '', 'Nothing to start right now.'].join('\n');
  }
  return [
    'You are in something right now.',
    '',
    `Next free: ${nextFreeAt.setZone(zone).toFormat('h:mm a')}.`,
    'Reply WHAT NOW then.',
  ].join('\n');
}

export interface DoneInput {
  completed: Task;
  completedCount: number;
  totalCount: number;
  next: Task | null;
  courses: Course[];
  /** Set when finishing this task unlocked startup work. */
  startupUnlocked?: boolean;
  /** Open academic tasks still due within 48h. */
  academicOutstandingCount?: number;
}

export function formatDone(input: DoneInput): string {
  const lines: string[] = [`${input.completedCount}/${input.totalCount} done.`];

  if (input.startupUnlocked) {
    lines.push('');
    // Two different things unlock startup work, and saying the wrong one is a
    // lie the user can see through: clearing the deck is not the same as
    // hitting a daily minute floor while an assignment is still due.
    lines.push(
      (input.academicOutstandingCount ?? 0) === 0
        ? 'Academic must-dos are done.'
        : "That's today's academic minimum.",
    );
    lines.push('Startup is unlocked.');
  }

  if (input.next) {
    lines.push('');
    lines.push('Next:');
    lines.push(shortTitle(input.next.title));
    lines.push(`Start: ${startLine(input.next)}`);
  } else {
    lines.push('');
    lines.push("That's the list. Nothing else is required today.");
  }
  return lines.join('\n');
}

/**
 * STUCK ladder. Each level cuts the ask roughly by an order of magnitude and
 * changes the expected reply, so the user always has a one-word way forward.
 */
export function formatStuck(task: Task, level: number, action: string): string {
  if (level <= 1) {
    return [
      'Ignore everything else.',
      '',
      action,
      '',
      'Reply DONE when finished.',
    ].join('\n');
  }
  if (level === 2) {
    return [
      "Don't solve anything yet.",
      '',
      action,
      '',
      "Reply OPEN when it's on screen.",
    ].join('\n');
  }
  return [action, '', "That's it.", '', 'Reply READY.'].join('\n');
}

export function formatSnoozed(task: Task, until: DateTime, zone: string): string {
  const local = until.setZone(zone);
  const sameDay = local.hasSame(DateTime.now().setZone(zone), 'day');
  const when = sameDay ? local.toFormat('h:mm a') : local.toFormat('ccc h:mm a');
  return [`Moved: ${shortTitle(task.title, 40)}`, `Back at ${when}.`].join('\n');
}

export function formatAdded(task: Task, unparsed: string | null): string {
  const lines = ['Got it.', '', shortTitle(task.title)];
  const details: string[] = [];
  if (task.dueAt) {
    const due = DateTime.fromISO(task.dueAt);
    if (due.isValid) details.push(due.toFormat('ccc LLL d'));
  }
  if (task.estimatedMinutes) details.push(humanDuration(task.estimatedMinutes));
  details.push(task.category);
  lines.push(details.join(' · '));
  if (unparsed) {
    lines.push('');
    lines.push('Saved the rest in notes.');
  }
  return lines.join('\n');
}

export interface SchoolHealthInput {
  courses: Course[];
  missingCount: number;
  dueNext7Days: number;
  examsNext14Days: number;
  mainObjective: string;
}

export function formatSchoolHealth(input: SchoolHealthInput): string {
  const lines = ['SCHOOL HEALTH', ''];

  for (const course of input.courses) {
    const grade = course.currentGrade ? ` (${course.currentGrade})` : '';
    lines.push(`${course.courseId}: ${course.riskLevel.toUpperCase()}${grade}`);
  }

  lines.push('');
  lines.push(`Missing: ${input.missingCount}`);
  lines.push(`Due next 7d: ${input.dueNext7Days}`);
  lines.push(`Exams next 14d: ${input.examsNext14Days}`);
  lines.push('');
  lines.push('Main objective:');
  lines.push(input.mainObjective);

  return lines.join('\n');
}

export function formatMathQuestion(conceptLabelText: string, prompt: string): string {
  return [`MATH — ${conceptLabelText}`, '', prompt, '', 'Reply with your answer.'].join('\n');
}

export function formatMathFeedback(
  correct: boolean,
  expected: string,
  nextPrompt: { conceptLabel: string; prompt: string } | null,
): string {
  const head = correct ? 'Correct.' : `Not quite — it's ${expected}.`;
  if (!nextPrompt) return `${head}\n\nDone for now. Reply MATH for more.`;
  return [head, '', `MATH — ${nextPrompt.conceptLabel}`, '', nextPrompt.prompt].join('\n');
}

export function formatMathUngraded(expected: string): string {
  return [
    "I couldn't read that as an answer, so I didn't mark it.",
    '',
    `The answer is ${expected}.`,
    '',
    'Reply MATH for the next one.',
  ].join('\n');
}

export function formatCareerBlock(minutes: number, action: string): string {
  return [`CAREER BLOCK — ${humanDuration(minutes)}`, '', action].join('\n');
}

export const HELP_TEXT = [
  'COMMANDS',
  '',
  'TODAY — today\'s top tasks',
  'WHAT NOW — one task, fits your free time',
  'DONE — mark current task complete',
  'STUCK — make the task smaller',
  'OPEN / READY — advance a tiny step',
  'SNOOZE 30m | 2h | 4pm | tomorrow',
  'RESCUE — cut today down to 2 tasks',
  'ADD <task> <when>',
  'MATH — one practice question',
  'STATUS — what the agent thinks right now',
  'HELP — this list',
].join('\n');

export function formatUnknownCommand(): string {
  return [
    "I didn't catch that.",
    '',
    'Try: WHAT NOW, DONE, STUCK, SNOOZE, RESCUE, ADD, MATH, HELP.',
  ].join('\n');
}
