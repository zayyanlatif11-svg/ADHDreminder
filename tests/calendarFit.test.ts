import { describe, expect, it } from 'vitest';
import { NOW, ZONE, at, config, event, task } from './helpers.js';
import { evaluateFit, selectForWindow } from '../src/prioritization/calendarFit.js';
import { scoreAll } from '../src/prioritization/score.js';
import {
  computeFreeWindows,
  currentFreeWindow,
  nextFixedEvent,
  totalFreeMinutes,
} from '../src/calendar/freeWindows.js';
import { planStudyBlocks } from '../src/calendar/studyBlocks.js';
import { windowMinutes } from '../src/utils/time.js';

describe('calendar fitting', () => {
  it('does not select a 60-minute task for a 15-minute window', () => {
    const long = task({ id: 'long', category: 'academic', estimatedMinutes: 60 });
    const ranked = scoreAll([long], { now: NOW, zone: ZONE, coursesById: new Map() });

    const selection = selectForWindow(ranked, {
      availableMinutes: 15,
      config: config({ micro_task_threshold_minutes: 20, transition_buffer_minutes: 5 }),
    });
    expect(selection).toBeNull();
  });

  it('never proposes a task needing more time than the window minus the buffer', () => {
    const cfg = config({ transition_buffer_minutes: 5 });
    // 18 minutes free, buffer 5 → only 13 usable, below the 20-minute micro threshold.
    expect(evaluateFit(task({ estimatedMinutes: 60 }), { availableMinutes: 18, config: cfg }).fits)
      .toBe(false);
    expect(evaluateFit(task({ estimatedMinutes: 10 }), { availableMinutes: 18, config: cfg }).fits)
      .toBe(true);
  });

  it('shrinks a long task instead of skipping it when the window is big enough', () => {
    const cfg = config({ micro_task_threshold_minutes: 20, transition_buffer_minutes: 5 });
    const fit = evaluateFit(task({ estimatedMinutes: 90 }), { availableMinutes: 45, config: cfg });

    expect(fit.fits).toBe(true);
    expect(fit.shrunkTo).toBe(40);
  });

  it('picks the highest-value task that actually fits, skipping ones that do not', () => {
    const big = task({ id: 'big', category: 'academic', importance: 5, estimatedMinutes: 120 });
    const small = task({ id: 'small', category: 'academic', importance: 3, estimatedMinutes: 15 });
    const ranked = scoreAll([big, small], { now: NOW, zone: ZONE, coursesById: new Map() });
    expect(ranked[0]?.task.id).toBe('big');

    const selection = selectForWindow(ranked, {
      availableMinutes: 22,
      config: config({ micro_task_threshold_minutes: 30, transition_buffer_minutes: 5 }),
    });
    expect(selection?.choice.task.id).toBe('small');
  });
});

describe('free windows', () => {
  const events = [
    event('MATH 1A', '2026-08-12T10:00:00', '2026-08-12T11:15:00'),
    event('Work shift', '2026-08-12T13:00:00', '2026-08-12T17:00:00'),
  ];

  it('respects fixed events when computing free time', () => {
    const windows = computeFreeWindows(events, ZONE, {
      from: NOW,
      to: at('2026-08-12T22:00:00'),
      minimumMinutes: 10,
    });

    // 09:00–10:00, 11:15–13:00, 17:00–22:00
    expect(windows).toHaveLength(3);
    expect(windowMinutes(windows[0]!)).toBe(60);
    expect(windowMinutes(windows[1]!)).toBe(105);
  });

  it('reports the window the user is in right now', () => {
    const window = currentFreeWindow(events, ZONE, NOW, at('2026-08-12T22:00:00'));
    expect(window).not.toBeNull();
    expect(windowMinutes(window!)).toBe(60);
  });

  it('returns no current window while the user is in a fixed event', () => {
    const during = at('2026-08-12T10:30:00');
    const window = currentFreeWindow(events, ZONE, during, at('2026-08-12T22:00:00'));
    // The next gap starts at 11:15, which is not "now".
    expect(window).toBeNull();
  });

  it('treats all-day events as markers, not as busy time', () => {
    const allDay = event('Midterm week', '2026-08-12T00:00:00', '2026-08-13T00:00:00', {
      allDay: true,
    });
    const windows = computeFreeWindows([allDay], ZONE, {
      from: NOW,
      to: at('2026-08-12T22:00:00'),
    });
    expect(totalFreeMinutes(windows)).toBeGreaterThan(0);
  });

  it('ignores events the user is marked free for', () => {
    const optional = event('Optional talk', '2026-08-12T10:00:00', '2026-08-12T11:00:00', {
      transparent: true,
    });
    const windows = computeFreeWindows([optional], ZONE, {
      from: NOW,
      to: at('2026-08-12T12:00:00'),
    });
    expect(windows).toHaveLength(1);
  });

  it('identifies the next fixed commitment', () => {
    const next = nextFixedEvent(events, ZONE, NOW);
    expect(next?.title).toBe('MATH 1A');
  });

  it('clips the day at the configured end so it never suggests late-night work', () => {
    const windows = computeFreeWindows([], ZONE, {
      from: NOW,
      to: at('2026-08-13T02:00:00'),
      dayEnd: '22:30',
    });
    const last = windows.at(-1);
    expect(last?.end.hour).toBe(22);
    expect(last?.end.minute).toBe(30);
  });
});

describe('study block planning', () => {
  it('never schedules a study block after the task is due', () => {
    const due = at('2026-08-13T12:00:00');
    const assignment = task({
      id: 'essay',
      category: 'academic',
      estimatedMinutes: 120,
      dueAt: due.toISO(),
    });

    const blocks = planStudyBlocks([assignment], [], {
      zone: ZONE,
      now: NOW,
      horizonDays: 5,
      maxSessionMinutes: 50,
      bufferMinutes: 5,
      dayStart: '07:30',
      dayEnd: '22:30',
      maxMinutesPerDay: 150,
    });

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.end.toMillis()).toBeLessThanOrEqual(due.toMillis());
    }
  });

  it('splits a large assignment into sessions no longer than the configured maximum', () => {
    const assignment = task({
      category: 'academic',
      estimatedMinutes: 180,
      dueAt: at('2026-08-15T23:59:00').toISO(),
    });

    const blocks = planStudyBlocks([assignment], [], {
      zone: ZONE,
      now: NOW,
      horizonDays: 5,
      maxSessionMinutes: 50,
      bufferMinutes: 5,
      dayStart: '07:30',
      dayEnd: '22:30',
      maxMinutesPerDay: 100,
    });

    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.end.diff(block.start, 'minutes').minutes).toBeLessThanOrEqual(50);
    }
  });

  it('does not place study blocks on top of fixed calendar events', () => {
    const busy = event('Work shift', '2026-08-12T09:00:00', '2026-08-12T20:00:00');
    const assignment = task({
      category: 'academic',
      estimatedMinutes: 60,
      dueAt: at('2026-08-12T22:00:00').toISO(),
    });

    const blocks = planStudyBlocks([assignment], [busy], {
      zone: ZONE,
      now: NOW,
      horizonDays: 0,
      maxSessionMinutes: 50,
      bufferMinutes: 5,
      dayStart: '07:30',
      dayEnd: '22:30',
      maxMinutesPerDay: 150,
    });

    for (const block of blocks) {
      const overlapsBusy =
        block.start.toJSDate() < busy.end && block.end.toJSDate() > busy.start;
      expect(overlapsBusy).toBe(false);
    }
  });

  it('respects the per-day ceiling rather than filling every free minute', () => {
    const assignment = task({
      category: 'academic',
      estimatedMinutes: 600,
      dueAt: at('2026-08-13T23:59:00').toISO(),
    });

    const blocks = planStudyBlocks([assignment], [], {
      zone: ZONE,
      now: NOW,
      horizonDays: 1,
      maxSessionMinutes: 50,
      bufferMinutes: 5,
      dayStart: '07:30',
      dayEnd: '22:30',
      maxMinutesPerDay: 100,
    });

    const perDay = new Map<string, number>();
    for (const block of blocks) {
      const key = block.start.toFormat('yyyy-LL-dd');
      const minutes = block.end.diff(block.start, 'minutes').minutes;
      perDay.set(key, (perDay.get(key) ?? 0) + minutes);
    }
    for (const total of perDay.values()) {
      expect(total).toBeLessThanOrEqual(100);
    }
  });
});
