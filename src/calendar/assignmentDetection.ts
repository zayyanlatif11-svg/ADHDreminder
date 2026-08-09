import type { CalendarEvent } from './types.js';
import type { Course } from '../tasks/types.js';

/**
 * Recognises academic deadlines that are already synced into a calendar
 * (Canvas → Google/Apple is the common path for this user).
 *
 * The rule is deliberately conservative: an event only becomes a task if it
 * looks like coursework AND lives on a calendar the user has associated with a
 * course. Treating every calendar event as a task would flood the backlog,
 * which is exactly the failure mode this product exists to prevent.
 */

export type AssignmentKind = 'exam' | 'project' | 'assignment' | 'quiz';

interface Pattern {
  kind: AssignmentKind;
  /** Higher wins when several patterns match. */
  weight: number;
  importance: number;
  estimatedMinutes: number;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  { kind: 'exam', weight: 100, importance: 5, estimatedMinutes: 120, regex: /\b(final exam|final|midterm|exam)\b/i },
  { kind: 'project', weight: 80, importance: 5, estimatedMinutes: 180, regex: /\b(project|paper|essay|presentation)\b/i },
  { kind: 'quiz', weight: 60, importance: 4, estimatedMinutes: 45, regex: /\b(quiz|test)\b/i },
  { kind: 'assignment', weight: 50, importance: 3, estimatedMinutes: 60, regex: /\b(assignment|homework|hw|problem set|pset|worksheet|lab|discussion post|discussion)\b/i },
  { kind: 'assignment', weight: 40, importance: 3, estimatedMinutes: 60, regex: /\b(due|deadline|submit|turn in)\b/i },
];

/** Things that look academic but are not work items. */
const NEGATIVE = /\b(office hours?|lecture|class|seminar|study group|review session|tutoring|holiday|break|no class)\b/i;

export interface DetectedAssignment {
  kind: AssignmentKind;
  title: string;
  dueAt: Date;
  courseId: string | null;
  importance: number;
  estimatedMinutes: number;
  calendarEventId: string;
  source: string;
}

export function classifyEventTitle(title: string): Pattern | null {
  if (NEGATIVE.test(title)) return null;
  let best: Pattern | null = null;
  for (const pattern of PATTERNS) {
    if (pattern.regex.test(title) && (best === null || pattern.weight > best.weight)) {
      best = pattern;
    }
  }
  return best;
}

/**
 * Matches an event to a course by the calendar it lives on, then by the course
 * name or id appearing in the event title.
 */
export function matchCourse(event: CalendarEvent, courses: Course[]): Course | null {
  const byCalendar = courses.find(
    (course) =>
      course.calendarId &&
      (course.calendarId === event.calendarName ||
        event.id.includes(course.calendarId) ||
        course.calendarId.toLowerCase() === event.calendarName.toLowerCase()),
  );
  if (byCalendar) return byCalendar;

  const haystack = `${event.title} ${event.calendarName}`.toLowerCase();
  return (
    courses.find((course) => {
      const id = course.courseId.toLowerCase();
      const name = course.name.toLowerCase();
      return (
        (id.length >= 3 && haystack.includes(id)) || (name.length >= 3 && haystack.includes(name))
      );
    }) ?? null
  );
}

export interface DetectOptions {
  /**
   * When false (the default), only events on course-linked calendars are
   * considered. Turning this on widens detection to any calendar, which is
   * noisier — offered for users whose school feed is on a general calendar.
   */
  allowUnlinkedCalendars?: boolean;
}

export function detectAssignments(
  events: CalendarEvent[],
  courses: Course[],
  options: DetectOptions = {},
): DetectedAssignment[] {
  const linkedCalendars = new Set(
    courses
      .map((course) => course.calendarId?.toLowerCase())
      .filter((id): id is string => Boolean(id)),
  );
  const hasLinkedCalendars = linkedCalendars.size > 0;

  const out: DetectedAssignment[] = [];
  for (const event of events) {
    const pattern = classifyEventTitle(event.title);
    if (!pattern) continue;

    const course = matchCourse(event, courses);
    const onLinkedCalendar =
      linkedCalendars.has(event.calendarName.toLowerCase()) || course !== null;

    // Without a course link, only proceed if the user explicitly opted in.
    if (hasLinkedCalendars && !onLinkedCalendar && !options.allowUnlinkedCalendars) continue;
    if (!hasLinkedCalendars && !options.allowUnlinkedCalendars && course === null) continue;

    // An all-day "due" event means end-of-day, not midnight-start.
    const dueAt = event.allDay ? new Date(event.start.getTime() + 23 * 3600_000) : event.end;

    out.push({
      kind: pattern.kind,
      title: event.title.trim(),
      dueAt,
      courseId: course?.courseId ?? null,
      // A red-risk course raises the stakes of the same assignment.
      importance: Math.min(5, pattern.importance + (course?.riskLevel === 'red' ? 1 : 0)),
      estimatedMinutes: pattern.estimatedMinutes,
      calendarEventId: event.id,
      source: `calendar:${event.source}`,
    });
  }
  return out;
}
