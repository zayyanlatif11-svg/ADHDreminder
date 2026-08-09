import { describe, expect, it } from 'vitest';
import { NOW, ZONE, config, course, task } from './helpers.js';
import { buildDailyPlan } from '../src/prioritization/planner.js';
import { rankTasks, isLockedByAcademics } from '../src/prioritization/engine.js';
import { assessAutoRescue } from '../src/prioritization/rescue.js';
import { evaluateRollover, promotedIds } from '../src/prioritization/rollover.js';
import { microActionFor } from '../src/commands/handlers.js';
import { formatDone, formatMorningMessage } from '../src/messaging/formatter.js';

const courses = [course({ courseId: 'CALC', riskLevel: 'red' })];

function planOptions(overrides = {}) {
  return {
    now: NOW,
    zone: ZONE,
    config: config(),
    courses,
    rescueActive: false,
    academicMinimumMet: true,
    freeMinutesToday: 480,
    ...overrides,
  };
}

describe('plan size discipline', () => {
  it('never exceeds the configured maximum, however many tasks exist', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      task({ id: `t${index}`, category: 'academic', importance: 5 }),
    );

    const plan = buildDailyPlan(many, planOptions({ config: config({ top_task_count: 3 }) }));
    expect(plan.entries).toHaveLength(3);
  });

  it('prefers variety when several categories are available', () => {
    const tasks = [
      task({ id: 'a1', category: 'academic', importance: 5 }),
      task({ id: 'a2', category: 'academic', importance: 5 }),
      task({ id: 'a3', category: 'academic', importance: 5 }),
      task({ id: 'career', category: 'recruiting', importance: 3 }),
    ];

    const plan = buildDailyPlan(tasks, planOptions({ config: config({ top_task_count: 3 }) }));
    const categories = plan.entries.map((entry) => entry.task.category);

    // Two academic + one career, rather than three academic blocks that read
    // as an impossible day.
    expect(categories.filter((c) => c === 'academic')).toHaveLength(2);
    expect(categories).toContain('recruiting');
  });

  it('honours a lowered top_task_count', () => {
    const many = Array.from({ length: 10 }, (_, index) => task({ id: `t${index}` }));
    const plan = buildDailyPlan(many, planOptions({ config: config({ top_task_count: 1 }) }));
    expect(plan.entries).toHaveLength(1);
  });

  it('shows at most two tasks in rescue mode', () => {
    const tasks = [
      task({ id: 'a', category: 'academic', importance: 5 }),
      task({ id: 'b', category: 'academic', importance: 5 }),
      task({ id: 'c', category: 'academic', importance: 5 }),
      task({ id: 'd', category: 'academic', importance: 4 }),
    ];

    const plan = buildDailyPlan(tasks, planOptions({ rescueActive: true }));
    expect(plan.entries.length).toBeLessThanOrEqual(2);
  });

  it('hides startup, learning and personal work in rescue mode', () => {
    const tasks = [
      task({ id: 'academic', category: 'academic' }),
      task({ id: 'startup', category: 'startup', importance: 5 }),
      task({ id: 'learning', category: 'learning', importance: 5 }),
      task({ id: 'personal', category: 'personal', importance: 5 }),
    ];

    const plan = buildDailyPlan(tasks, planOptions({ rescueActive: true }));
    const ids = plan.entries.map((entry) => entry.task.id);
    expect(ids).toContain('academic');
    expect(ids).not.toContain('startup');
    expect(ids).not.toContain('learning');
    expect(ids).not.toContain('personal');
  });

  it('keeps an imminent high-impact recruiting deadline alive through rescue', () => {
    const tasks = [
      task({
        id: 'interview-prep',
        category: 'recruiting',
        importance: 5,
        dueAt: NOW.plus({ hours: 12 }).toISO(),
      }),
      task({ id: 'routine-apps', category: 'recruiting', importance: 3 }),
    ];

    const plan = buildDailyPlan(tasks, planOptions({ rescueActive: true }));
    const ids = plan.entries.map((entry) => entry.task.id);
    expect(ids).toContain('interview-prep');
    expect(ids).not.toContain('routine-apps');
  });
});

describe('academic lock and startup unlock', () => {
  const lockOptions = {
    now: NOW,
    zone: ZONE,
    config: config({ academic_lock_enabled: true }),
    rescueActive: false,
    academicMinimumMet: false,
  };

  it('does not unlock startup work before the academic minimum is met', () => {
    const startup = task({ id: 'startup', category: 'startup', importance: 5 });
    expect(isLockedByAcademics(startup, lockOptions)).toBe(true);

    const { ranked } = rankTasks([startup, task({ id: 'academic', category: 'academic' })], {
      ...lockOptions,
      courses,
    });
    expect(ranked.map((entry) => entry.task.id)).not.toContain('startup');
  });

  it('unlocks startup work once the academic minimum is met', () => {
    const startup = task({ id: 'startup', category: 'startup' });
    expect(isLockedByAcademics(startup, { ...lockOptions, academicMinimumMet: true })).toBe(false);

    const { ranked } = rankTasks([startup], {
      ...lockOptions,
      academicMinimumMet: true,
      courses,
    });
    expect(ranked.map((entry) => entry.task.id)).toContain('startup');
  });

  it('still allows a hard-deadline startup commitment through the lock', () => {
    const urgent = task({
      id: 'urgent-startup',
      category: 'startup',
      importance: 5,
      dueAt: NOW.plus({ hours: 6 }).toISO(),
    });
    expect(isLockedByAcademics(urgent, lockOptions)).toBe(false);
  });

  it('leaves startup visible when the lock is disabled', () => {
    const startup = task({ id: 'startup', category: 'startup' });
    expect(
      isLockedByAcademics(startup, {
        ...lockOptions,
        config: config({ academic_lock_enabled: false }),
      }),
    ).toBe(false);
  });
});

describe('STUCK reduces the size of the action', () => {
  const subject = task({ title: 'Calc factoring practice', nextAction: 'Do 8 factoring problems.' });

  it('produces a progressively smaller action at each level', () => {
    const first = microActionFor(subject, 1);
    const second = microActionFor(subject, 2);
    const third = microActionFor(subject, 3);

    expect(first).not.toBe(second);
    expect(second).not.toBe(third);

    // The ladder is defined by what is ASKED FOR, not by string length:
    // level 1 still involves doing the work, level 2 only gets it on screen,
    // level 3 asks for nothing but physical presence.
    expect(first.toLowerCase()).toContain('factoring problems');
    expect(second.toLowerCase()).toContain('open');
    expect(second.toLowerCase()).not.toContain('factoring problems');
    expect(third.toLowerCase()).toContain('in front of you');
    expect(third.toLowerCase()).not.toMatch(/\b(do|solve|answer|complete|open)\b/);
  });

  it('caps the ladder at level 3 rather than shrinking forever', () => {
    expect(microActionFor(subject, 4)).toBe(microActionFor(subject, 3));
    expect(microActionFor(subject, 9)).toBe(microActionFor(subject, 3));
  });

  it('does not append to a sheet action in a way that produces double punctuation', () => {
    expect(microActionFor(subject, 1)).not.toContain('. —');
  });

  it('still produces a usable action when no next action is set', () => {
    const bare = task({ title: 'Econ discussion post', nextAction: null });
    expect(microActionFor(bare, 1)).toContain('Econ discussion post');
    expect(microActionFor(bare, 3)).toContain('Econ discussion post');
  });
});

describe('missed tasks do not snowball', () => {
  it('promotes only genuinely urgent leftovers, not everything missed', () => {
    const tasks = [
      task({ id: 'urgent', category: 'academic', dueAt: NOW.plus({ hours: 20 }).toISO() }),
      task({ id: 'far-off', category: 'academic', dueAt: NOW.plus({ days: 10 }).toISO() }),
      task({ id: 'no-deadline', category: 'personal' }),
      task({
        id: 'avoided-learning',
        category: 'learning',
        avoidanceCount: 4,
      }),
    ];

    const decisions = evaluateRollover(tasks, {
      now: NOW,
      zone: ZONE,
      missedTaskIds: new Set(tasks.map((t) => t.id)),
    });

    const byId = new Map(decisions.map((d) => [d.task.id, d.action]));
    expect(byId.get('urgent')).toBe('promote');
    expect(byId.get('far-off')).toBe('keep_backlog');
    expect(byId.get('no-deadline')).toBe('keep_backlog');
    expect(byId.get('avoided-learning')).toBe('reschedule');

    expect(promotedIds(decisions).size).toBe(1);
  });

  it('closes out low-impact work whose deadline has long passed', () => {
    const stale = task({
      id: 'stale',
      category: 'personal',
      importance: 1,
      dueAt: NOW.minus({ days: 5 }).toISO(),
    });

    const decisions = evaluateRollover([stale], {
      now: NOW,
      zone: ZONE,
      missedTaskIds: new Set(['stale']),
    });
    expect(decisions[0]?.action).toBe('expire');
  });

  it('keeps the morning message capped even when everything was missed', () => {
    const missed = Array.from({ length: 12 }, (_, index) =>
      task({
        id: `missed-${index}`,
        category: 'academic',
        dueAt: NOW.plus({ hours: 12 }).toISO(),
      }),
    );

    const plan = buildDailyPlan(missed, planOptions({ config: config({ top_task_count: 3 }) }));
    expect(plan.entries.length).toBeLessThanOrEqual(3);
  });
});

describe('automatic rescue', () => {
  const rescueOptions = {
    now: NOW,
    zone: ZONE,
    config: config(),
    courses,
    freeMinutesToday: 240,
  };

  it('activates on two or more meaningful overdue academic tasks', () => {
    const overdue = [
      task({ category: 'academic', importance: 4, dueAt: NOW.minus({ days: 1 }).toISO() }),
      task({ category: 'academic', importance: 4, dueAt: NOW.minus({ days: 2 }).toISO() }),
    ];

    const assessment = assessAutoRescue(overdue, rescueOptions);
    expect(assessment.shouldActivate).toBe(true);
    expect(assessment.triggers).toContain('overdue_academic');
  });

  it('activates when a high-impact deadline lands within 24 hours', () => {
    const imminent = [
      task({ category: 'academic', importance: 5, dueAt: NOW.plus({ hours: 10 }).toISO() }),
    ];
    const assessment = assessAutoRescue(imminent, rescueOptions);
    expect(assessment.triggers).toContain('imminent_deadline');
  });

  it('activates when required work materially exceeds available free time', () => {
    const heavy = [
      task({ category: 'academic', importance: 3, estimatedMinutes: 200, dueAt: NOW.plus({ hours: 30 }).toISO() }),
      task({ category: 'academic', importance: 3, estimatedMinutes: 200, dueAt: NOW.plus({ hours: 40 }).toISO() }),
    ];
    const assessment = assessAutoRescue(heavy, { ...rescueOptions, freeMinutesToday: 120 });
    expect(assessment.triggers).toContain('overloaded_day');
  });

  it('stays off on a calm day', () => {
    const calm = [task({ category: 'personal', importance: 2 })];
    const assessment = assessAutoRescue(calm, rescueOptions);
    expect(assessment.shouldActivate).toBe(false);
    expect(assessment.triggers).toHaveLength(0);
  });

  it('never activates when the feature is disabled', () => {
    const overdue = [
      task({ category: 'academic', importance: 5, dueAt: NOW.minus({ days: 1 }).toISO() }),
      task({ category: 'academic', importance: 5, dueAt: NOW.minus({ days: 3 }).toISO() }),
    ];
    const assessment = assessAutoRescue(overdue, {
      ...rescueOptions,
      config: config({ automatic_rescue_enabled: false }),
    });
    expect(assessment.shouldActivate).toBe(false);
  });
});

describe('the startup-unlock message tells the truth', () => {
  const base = {
    completed: task({ title: 'Calc practice', category: 'academic' as const }),
    completedCount: 1,
    totalCount: 3,
    next: task({ title: 'Finish Econ discussion post', category: 'academic' as const }),
    courses,
    startupUnlocked: true,
  };

  it('does not claim academics are done while an academic task is still due', () => {
    const message = formatDone({ ...base, academicOutstandingCount: 1 });

    // The exact failure seen in the simulation: "Academic must-dos are done."
    // printed directly above an outstanding academic task.
    expect(message).not.toContain('Academic must-dos are done.');
    expect(message).toContain("That's today's academic minimum.");
    expect(message).toContain('Startup is unlocked.');
  });

  it('does say academics are done when nothing academic remains', () => {
    const message = formatDone({ ...base, academicOutstandingCount: 0, next: null });

    expect(message).toContain('Academic must-dos are done.');
    expect(message).toContain('Startup is unlocked.');
  });

  it('says nothing about startup when it has not unlocked', () => {
    const message = formatDone({ ...base, startupUnlocked: false, academicOutstandingCount: 1 });

    expect(message).not.toContain('Startup is unlocked.');
    expect(message).not.toContain('Academic must-dos are done.');
  });
});

describe('message tone', () => {
  const forbidden = [
    /you failed/i,
    /you missed/i,
    /you should have/i,
    /you'?re behind/i,
    /\b\d+\s+(?:overdue|missed)\b/i,
  ];

  it('never uses guilt language in the morning message', () => {
    const tasks = [
      task({ id: 'a', category: 'academic', dueAt: NOW.minus({ days: 3 }).toISO() }),
      task({ id: 'b', category: 'academic', dueAt: NOW.minus({ days: 1 }).toISO() }),
    ];
    const plan = buildDailyPlan(tasks, planOptions());

    const message = formatMorningMessage({
      now: NOW,
      zone: ZONE,
      entries: plan.entries,
      keystone: plan.keystone,
      courses,
      rescue: false,
    });

    for (const pattern of forbidden) {
      expect(message).not.toMatch(pattern);
    }
  });

  it('explains an auto-rescue in one line without lecturing', () => {
    const tasks = [task({ id: 'a', category: 'academic' })];
    const plan = buildDailyPlan(tasks, planOptions({ rescueActive: true }));

    const message = formatMorningMessage({
      now: NOW,
      zone: ZONE,
      entries: plan.entries,
      keystone: plan.keystone,
      courses,
      rescue: true,
      autoRescue: true,
    });

    expect(message).toContain('Today is overloaded, so I cut the plan down.');
    expect(message.split('\n').length).toBeLessThan(15);
  });

  it('keeps the morning message short enough to read without scrolling', () => {
    const tasks = Array.from({ length: 10 }, (_, index) =>
      task({ id: `t${index}`, category: 'academic', title: `Task number ${index}` }),
    );
    const plan = buildDailyPlan(tasks, planOptions());

    const message = formatMorningMessage({
      now: NOW,
      zone: ZONE,
      entries: plan.entries,
      keystone: plan.keystone,
      courses,
      rescue: false,
    });

    expect(message.split('\n').length).toBeLessThanOrEqual(20);
    expect(message.length).toBeLessThan(600);
  });

  it('never dumps the whole backlog', () => {
    const tasks = Array.from({ length: 30 }, (_, index) =>
      task({ id: `t${index}`, title: `Backlog item ${index}`, category: 'academic' }),
    );
    const plan = buildDailyPlan(tasks, planOptions());

    const message = formatMorningMessage({
      now: NOW,
      zone: ZONE,
      entries: plan.entries,
      keystone: plan.keystone,
      courses,
      rescue: false,
    });

    const mentioned = tasks.filter((t) => message.includes(t.title)).length;
    expect(mentioned).toBeLessThanOrEqual(3);
  });
});
