import { describe, expect, it } from 'vitest';
import { NOW, ZONE, config, course, task } from './helpers.js';
import { rankTasks, computeAcademicMinimumMet, isSnoozed } from '../src/prioritization/engine.js';
import { scoreAll } from '../src/prioritization/score.js';

const baseOptions = {
  now: NOW,
  zone: ZONE,
  config: config(),
  courses: [course({ courseId: 'CALC', riskLevel: 'red' })],
  rescueActive: false,
  academicMinimumMet: true, // unlock startup unless a test says otherwise
};

function rankIds(tasks: Parameters<typeof rankTasks>[0], overrides = {}) {
  return rankTasks(tasks, { ...baseOptions, ...overrides }).ranked.map((entry) => entry.task.id);
}

describe('priority engine', () => {
  it('ranks academic work above startup work', () => {
    const academic = task({ id: 'academic', category: 'academic', importance: 3 });
    const startup = task({ id: 'startup', category: 'startup', importance: 5 });

    // Startup is given HIGHER importance to prove category dominates.
    expect(rankIds([startup, academic])).toEqual(['academic', 'startup']);
  });

  it('ranks an overdue academic task above routine recruiting', () => {
    const overdue = task({
      id: 'overdue-academic',
      category: 'academic',
      dueAt: NOW.minus({ days: 2 }).toISO(),
      importance: 4,
    });
    const recruiting = task({
      id: 'recruiting',
      category: 'recruiting',
      dueAt: NOW.plus({ days: 10 }).toISO(),
      importance: 3,
    });

    expect(rankIds([recruiting, overdue])[0]).toBe('overdue-academic');
  });

  it('lets an interview today outrank low-impact homework', () => {
    const interview = task({
      id: 'interview',
      category: 'career_fixed',
      dueAt: NOW.plus({ hours: 4 }).toISO(),
      importance: 5,
    });
    const homework = task({
      id: 'homework',
      category: 'academic',
      dueAt: NOW.plus({ days: 9 }).toISO(),
      importance: 1,
    });

    expect(rankIds([homework, interview])[0]).toBe('interview');
  });

  it('boosts a task on a red-risk course above the same task on a green one', () => {
    const red = task({ id: 'red', category: 'academic', course: 'CALC', courseRisk: 'red' });
    const green = task({ id: 'green', category: 'academic', course: 'ECON', courseRisk: 'green' });

    const scored = scoreAll([green, red], {
      now: NOW,
      zone: ZONE,
      coursesById: new Map(),
    });
    expect(scored[0]?.task.id).toBe('red');
    expect(scored[0]!.factors['risk']).toBeGreaterThan(scored[1]!.factors['risk'] as number);
  });

  it('raises priority as a deadline approaches', () => {
    const soon = task({ id: 'soon', category: 'academic', dueAt: NOW.plus({ hours: 12 }).toISO() });
    const later = task({ id: 'later', category: 'academic', dueAt: NOW.plus({ days: 6 }).toISO() });

    expect(rankIds([later, soon])).toEqual(['soon', 'later']);
  });

  it('does not select a snoozed task before its snooze expires', () => {
    const snoozed = task({
      id: 'snoozed',
      category: 'academic',
      importance: 5,
      status: 'snoozed',
      snoozedUntil: NOW.plus({ hours: 3 }).toISO(),
    });
    const normal = task({ id: 'normal', category: 'personal' });

    expect(isSnoozed(snoozed, NOW, ZONE)).toBe(true);
    expect(rankIds([snoozed, normal])).toEqual(['normal']);
  });

  it('returns a snoozed task to the ranking once the snooze has passed', () => {
    const expired = task({
      id: 'expired',
      category: 'academic',
      status: 'snoozed',
      snoozedUntil: NOW.minus({ minutes: 5 }).toISO(),
    });

    expect(isSnoozed(expired, NOW, ZONE)).toBe(false);
    expect(rankIds([expired])).toEqual(['expired']);
  });

  it('honours a manual priority override', () => {
    const boosted = task({ id: 'boosted', category: 'personal', priorityOverride: 10 });
    const academic = task({ id: 'academic', category: 'academic' });

    expect(rankIds([academic, boosted])[0]).toBe('boosted');
  });

  it('caps how much an ancient overdue task can dominate', () => {
    const ancient = task({
      id: 'ancient',
      category: 'academic',
      dueAt: NOW.minus({ days: 30 }).toISO(),
    });
    const dueSoon = task({
      id: 'due-soon',
      category: 'academic',
      dueAt: NOW.plus({ hours: 5 }).toISO(),
    });

    // An imminent deadline should beat something that has been rotting for a month.
    expect(rankIds([ancient, dueSoon])[0]).toBe('due-soon');
  });

  it('excludes completed and cancelled tasks entirely', () => {
    const done = task({ id: 'done', category: 'academic', status: 'completed' });
    const cancelled = task({ id: 'cancelled', category: 'academic', status: 'cancelled' });
    const open = task({ id: 'open', category: 'personal' });

    expect(rankIds([done, cancelled, open])).toEqual(['open']);
  });
});

describe('academic minimum', () => {
  it('is met when enough academic minutes were completed today', () => {
    const completed = task({
      category: 'academic',
      status: 'completed',
      estimatedMinutes: 40,
      completedAt: NOW.minus({ hours: 1 }).toISO(),
    });
    const outstanding = task({
      category: 'academic',
      dueAt: NOW.plus({ hours: 5 }).toISO(),
    });

    const result = computeAcademicMinimumMet([completed, outstanding], {
      now: NOW,
      zone: ZONE,
      config: config({ academic_minimum_minutes: 30 }),
    });
    expect(result.completedMinutes).toBe(40);
    expect(result.met).toBe(true);
  });

  it('is not met when an academic task is due within 48h and nothing is done', () => {
    const outstanding = task({ category: 'academic', dueAt: NOW.plus({ hours: 20 }).toISO() });

    const result = computeAcademicMinimumMet([outstanding], {
      now: NOW,
      zone: ZONE,
      config: config({ academic_minimum_minutes: 30 }),
    });
    expect(result.met).toBe(false);
    expect(result.outstanding).toHaveLength(1);
  });

  it('ignores academic work completed on a previous day', () => {
    const yesterday = task({
      category: 'academic',
      status: 'completed',
      estimatedMinutes: 90,
      completedAt: NOW.minus({ days: 1 }).toISO(),
    });
    const outstanding = task({ category: 'academic', dueAt: NOW.plus({ hours: 10 }).toISO() });

    const result = computeAcademicMinimumMet([yesterday, outstanding], {
      now: NOW,
      zone: ZONE,
      config: config({ academic_minimum_minutes: 30 }),
    });
    expect(result.completedMinutes).toBe(0);
    expect(result.met).toBe(false);
  });
});
