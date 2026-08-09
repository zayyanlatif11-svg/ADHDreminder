import { DateTime } from 'luxon';
import type { Course, Task } from '../src/tasks/types.js';
import type { CalendarEvent } from '../src/calendar/types.js';
import { parseRuntimeConfig, type RuntimeConfig } from '../src/config/runtimeConfig.js';

export const ZONE = 'America/Los_Angeles';

/** A fixed Wednesday mid-morning, so weekday-sensitive logic is stable. */
export const NOW = DateTime.fromISO('2026-08-12T09:00:00', { zone: ZONE });

export function at(iso: string): DateTime {
  return DateTime.fromISO(iso, { zone: ZONE });
}

export function config(overrides: Record<string, string | number | boolean> = {}): RuntimeConfig {
  return parseRuntimeConfig({ timezone: ZONE, ...overrides });
}

let counter = 0;

export function task(overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    id: overrides.id ?? `task-${counter}`,
    title: overrides.title ?? `Task ${counter}`,
    category: overrides.category ?? 'personal',
    course: overrides.course ?? null,
    dueAt: overrides.dueAt ?? null,
    estimatedMinutes: overrides.estimatedMinutes ?? 30,
    importance: overrides.importance ?? 3,
    difficulty: overrides.difficulty ?? 3,
    courseRisk: overrides.courseRisk ?? null,
    priorityOverride: overrides.priorityOverride ?? null,
    status: overrides.status ?? 'ready',
    nextAction: overrides.nextAction ?? null,
    source: overrides.source ?? 'test',
    calendarEventId: overrides.calendarEventId ?? null,
    recurrence: overrides.recurrence ?? null,
    createdAt: overrides.createdAt ?? NOW.minus({ days: 1 }).toISO(),
    completedAt: overrides.completedAt ?? null,
    snoozedUntil: overrides.snoozedUntil ?? null,
    lastPromptedAt: overrides.lastPromptedAt ?? null,
    avoidanceCount: overrides.avoidanceCount ?? 0,
    notes: overrides.notes ?? null,
  };
}

export function course(overrides: Partial<Course> = {}): Course {
  return {
    courseId: overrides.courseId ?? 'CALC',
    name: overrides.name ?? 'Calculus I',
    calendarId: overrides.calendarId ?? null,
    currentGrade: overrides.currentGrade ?? null,
    riskLevel: overrides.riskLevel ?? 'green',
    creditUnits: overrides.creditUnits ?? 5,
    dailyMinimumMinutes: overrides.dailyMinimumMinutes ?? 0,
    notes: overrides.notes ?? null,
  };
}

export function event(
  title: string,
  startIso: string,
  endIso: string,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id: overrides.id ?? `event-${title}-${startIso}`,
    title,
    start: at(startIso).toJSDate(),
    end: at(endIso).toJSDate(),
    allDay: overrides.allDay ?? false,
    calendarName: overrides.calendarName ?? 'Test',
    source: overrides.source ?? 'google',
    location: overrides.location ?? null,
    description: overrides.description ?? null,
    transparent: overrides.transparent,
  };
}

/** Builds a BlueBubbles-shaped webhook body for adapter tests. */
export function webhookBody(
  overrides: {
    guid?: string;
    text?: string;
    isFromMe?: boolean;
    handle?: string;
    chatGuid?: string;
    type?: string;
  } = {},
): unknown {
  return {
    type: overrides.type ?? 'new-message',
    data: {
      guid: overrides.guid ?? 'msg-1',
      text: overrides.text ?? 'WHAT NOW',
      isFromMe: overrides.isFromMe ?? false,
      dateCreated: 1786000000000,
      handle: { address: overrides.handle ?? '+15551234567', service: 'iMessage' },
      chats: [{ guid: overrides.chatGuid ?? 'iMessage;-;+15551234567' }],
    },
  };
}
