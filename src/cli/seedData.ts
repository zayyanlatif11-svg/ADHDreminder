import { DateTime } from 'luxon';
import type { Course, MathMasteryRow, Task } from '../tasks/types.js';

/**
 * Demo data for `npm run simulate` and for bootstrapping a fresh spreadsheet.
 *
 * It is built around one deliberate scenario: there is genuinely interesting
 * startup and learning work available, and the system should still put Calc
 * and Econ in front of it. If a change to the engine ever lets DiliPilot
 * outreach outrank a red-risk Calc task, the simulation shows it immediately.
 */

export function seedCourses(): Course[] {
  return [
    {
      courseId: 'CALC',
      name: 'Calculus I',
      calendarId: null,
      currentGrade: null,
      riskLevel: 'red',
      creditUnits: 5,
      dailyMinimumMinutes: 30,
      notes: 'Retake. Algebra gaps: signed numbers, fractions, exponents, factoring.',
    },
    {
      courseId: 'ECON',
      name: 'Microeconomics',
      calendarId: null,
      currentGrade: null,
      riskLevel: 'green',
      creditUnits: 3,
      dailyMinimumMinutes: 0,
      notes: null,
    },
    {
      courseId: 'ACCT',
      name: 'Financial Accounting',
      calendarId: null,
      currentGrade: null,
      riskLevel: 'yellow',
      creditUnits: 4,
      dailyMinimumMinutes: 15,
      notes: null,
    },
  ];
}

export function seedTasks(now: DateTime): Task[] {
  const iso = (dt: DateTime): string => dt.toISO() ?? '';
  const base = {
    completedAt: null,
    snoozedUntil: null,
    lastPromptedAt: null,
    avoidanceCount: 0,
    priorityOverride: null,
    calendarEventId: null,
    recurrence: null,
    notes: null,
  };

  return [
    {
      ...base,
      id: 'calc-practice',
      title: 'Calc factoring practice — 8 problems',
      category: 'academic',
      course: 'CALC',
      dueAt: iso(now.plus({ days: 2 }).set({ hour: 23, minute: 59 })),
      estimatedMinutes: 35,
      importance: 5,
      difficulty: 4,
      courseRisk: 'red',
      status: 'ready',
      nextAction: 'Open the worksheet and do problem #1.',
      source: 'seed',
      createdAt: iso(now.minus({ days: 3 })),
      avoidanceCount: 2,
    },
    {
      ...base,
      id: 'econ-discussion',
      title: 'Finish Econ discussion post',
      category: 'academic',
      course: 'ECON',
      dueAt: iso(now.plus({ days: 1 }).set({ hour: 23, minute: 59 })),
      estimatedMinutes: 25,
      importance: 4,
      difficulty: 2,
      courseRisk: 'green',
      status: 'ready',
      nextAction: 'Open Canvas and reread the prompt.',
      source: 'seed',
      createdAt: iso(now.minus({ days: 2 })),
    },
    {
      ...base,
      id: 'acct-worksheet',
      title: 'Accounting chapter 4 worksheet',
      category: 'academic',
      course: 'ACCT',
      dueAt: iso(now.plus({ days: 5 }).set({ hour: 23, minute: 59 })),
      estimatedMinutes: 45,
      importance: 3,
      difficulty: 3,
      courseRisk: 'yellow',
      status: 'ready',
      nextAction: 'Open the worksheet PDF.',
      source: 'seed',
      createdAt: iso(now.minus({ days: 1 })),
    },
    {
      ...base,
      id: 'finance-apps',
      title: 'Submit 2 finance internship applications',
      category: 'recruiting',
      course: null,
      dueAt: iso(now.plus({ days: 4 }).set({ hour: 17 })),
      estimatedMinutes: 45,
      importance: 4,
      difficulty: 3,
      courseRisk: null,
      status: 'ready',
      nextAction: 'Open the tracker spreadsheet and pick the top 2.',
      source: 'seed',
      createdAt: iso(now.minus({ days: 5 })),
    },
    {
      ...base,
      id: 'startup-outreach',
      title: 'DiliPilot outreach — 10 messages',
      category: 'startup',
      course: null,
      dueAt: null,
      estimatedMinutes: 30,
      importance: 3,
      difficulty: 2,
      courseRisk: null,
      status: 'ready',
      nextAction: 'Open the outreach list.',
      source: 'seed',
      createdAt: iso(now.minus({ days: 6 })),
    },
    {
      ...base,
      id: 'python-study',
      title: 'Python pandas tutorial',
      category: 'learning',
      course: null,
      dueAt: null,
      estimatedMinutes: 60,
      importance: 2,
      difficulty: 2,
      courseRisk: null,
      status: 'ready',
      nextAction: 'Open the tutorial and run the first cell.',
      source: 'seed',
      createdAt: iso(now.minus({ days: 10 })),
      avoidanceCount: 3,
    },
    {
      ...base,
      id: 'renew-parking',
      title: 'Renew campus parking permit',
      category: 'personal',
      course: null,
      dueAt: iso(now.plus({ days: 12 }).set({ hour: 17 })),
      estimatedMinutes: 10,
      importance: 2,
      difficulty: 1,
      courseRisk: null,
      status: 'ready',
      nextAction: 'Open the parking portal.',
      source: 'seed',
      createdAt: iso(now.minus({ days: 1 })),
    },
  ] satisfies Task[];
}

export function seedMastery(): MathMasteryRow[] {
  return [
    { concept: 'signed_numbers', mastery: 0.25, attempts: 4, correct: 1, lastPracticed: null, nextReview: null, notes: null },
    { concept: 'fractions', mastery: 0.15, attempts: 2, correct: 0, lastPracticed: null, nextReview: null, notes: null },
    { concept: 'exponents', mastery: 0.4, attempts: 5, correct: 2, lastPracticed: null, nextReview: null, notes: null },
    { concept: 'factoring', mastery: 0.1, attempts: 1, correct: 0, lastPracticed: null, nextReview: null, notes: null },
  ];
}

/** A realistic weekday: two classes, a shift, and MMA in the evening. */
export function seedCalendarEvents(now: DateTime) {
  const at = (hour: number, minute = 0): Date =>
    now.set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();

  return [
    {
      id: 'seed:calc-class',
      title: 'MATH 1A Lecture',
      start: at(10, 0),
      end: at(11, 15),
      allDay: false,
      calendarName: 'School',
      source: 'google' as const,
    },
    {
      id: 'seed:econ-class',
      title: 'ECON 1 Lecture',
      start: at(13, 0),
      end: at(14, 15),
      allDay: false,
      calendarName: 'School',
      source: 'google' as const,
    },
    {
      id: 'seed:mma',
      title: 'MMA training',
      start: at(18, 30),
      end: at(20, 0),
      allDay: false,
      calendarName: 'Personal',
      source: 'apple' as const,
    },
  ];
}
