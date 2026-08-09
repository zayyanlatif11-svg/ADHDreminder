import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { ZONE } from './helpers.js';
import {
  courseToRow,
  masteryToRow,
  parseSheetDate,
  rowToCourse,
  rowToMastery,
  rowToTask,
  taskToRow,
} from '../src/sheets/rowMapping.js';
import { TASK_COLUMNS, COURSE_COLUMNS, columnLetter, headerIndex } from '../src/sheets/schema.js';
import { parseRuntimeConfig, DEFAULT_RUNTIME_CONFIG } from '../src/config/runtimeConfig.js';
import { MemoryRepository } from '../src/sheets/memoryRepository.js';

const HEADERS = [...TASK_COLUMNS];

describe('sheet column helpers', () => {
  it('converts column indices to letters', () => {
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(28)).toBe('AB');
  });

  it('maps headers case- and space-insensitively', () => {
    const index = headerIndex(['ID', 'Task Title', 'due_at']);
    expect(index['id']).toBe(0);
    expect(index['task_title']).toBe(1);
    expect(index['due_at']).toBe(2);
  });

  it('tolerates reordered columns', () => {
    const reordered = ['title', 'id', 'category'];
    const task = rowToTask(['Read chapter 3', 'x1', 'academic'], reordered, 2);
    expect(task?.id).toBe('x1');
    expect(task?.title).toBe('Read chapter 3');
    expect(task?.category).toBe('academic');
  });
});

describe('task row mapping', () => {
  it('round-trips a task through the sheet representation', () => {
    const original = rowToTask(
      ['t1', 'Calc practice', 'academic', 'CALC', '2026-08-14T23:59:00Z', '35', '5', '4', 'red', '', 'ready', 'Open the worksheet.', 'manual', '', '', '', '', '', '', '2', 'note'],
      HEADERS,
      2,
    );
    expect(original).not.toBeNull();

    const row = taskToRow(original!);
    const restored = rowToTask(row, HEADERS, 2);

    expect(restored?.id).toBe('t1');
    expect(restored?.category).toBe('academic');
    expect(restored?.estimatedMinutes).toBe(35);
    expect(restored?.importance).toBe(5);
    expect(restored?.courseRisk).toBe('red');
    expect(restored?.avoidanceCount).toBe(2);
    expect(restored?.nextAction).toBe('Open the worksheet.');
  });

  it('skips blank spacer rows without erroring', () => {
    expect(rowToTask([], HEADERS, 5)).toBeNull();
    expect(rowToTask(['', '', ''], HEADERS, 5)).toBeNull();
  });

  it('falls back to safe defaults on a typo rather than throwing', () => {
    const task = rowToTask(
      ['t2', 'Something', 'acadmic', '', '', 'abc', '99', '-4', 'purple', '', 'wat'],
      HEADERS,
      3,
    );
    // A single bad row must never stop the morning message going out.
    expect(task?.category).toBe('personal');
    expect(task?.estimatedMinutes).toBe(30);
    expect(task?.importance).toBe(5);
    expect(task?.difficulty).toBe(1);
    expect(task?.courseRisk).toBeNull();
    expect(task?.status).toBe('ready');
  });

  it('normalises category and status spelling variants', () => {
    const task = rowToTask(['t3', 'x', 'Career Fixed', '', '', '', '', '', '', '', 'Ready'], HEADERS, 4);
    expect(task?.category).toBe('career_fixed');
    expect(task?.status).toBe('ready');
  });

  it('clamps out-of-range numeric fields', () => {
    const task = rowToTask(['t4', 'x', 'academic', '', '', '99999', '9', '9'], HEADERS, 5);
    expect(task?.estimatedMinutes).toBe(600);
    expect(task?.importance).toBe(5);
    expect(task?.difficulty).toBe(5);
  });

  it('gives a row without an id a stable synthetic one', () => {
    const task = rowToTask(['', 'Untitled work'], HEADERS, 7);
    expect(task?.id).toBe('row-7');
  });
});

describe('date parsing from human-edited cells', () => {
  it('accepts several formats a person might type', () => {
    expect(parseSheetDate('2026-08-14T23:59:00Z')).toBe('2026-08-14T23:59:00.000Z');
    expect(parseSheetDate('2026-08-14 14:00')).not.toBeNull();
    expect(parseSheetDate('August 14, 2026')).not.toBeNull();
  });

  it('returns null rather than inventing a deadline', () => {
    expect(parseSheetDate(null)).toBeNull();
    expect(parseSheetDate('')).toBeNull();
    expect(parseSheetDate('   ')).toBeNull();
    expect(parseSheetDate('sometime next week maybe')).toBeNull();
  });
});

describe('course and mastery mapping', () => {
  it('round-trips a course', () => {
    const course = rowToCourse(
      ['CALC', 'Calculus I', 'MATH 1A', 'D', 'red', '5', '30', 'retake'],
      [...COURSE_COLUMNS],
      2,
    );
    expect(course?.riskLevel).toBe('red');
    expect(course?.dailyMinimumMinutes).toBe(30);

    const restored = rowToCourse(courseToRow(course!), [...COURSE_COLUMNS], 2);
    expect(restored?.courseId).toBe('CALC');
    expect(restored?.currentGrade).toBe('D');
  });

  it('defaults an unrecognised risk level to green rather than failing', () => {
    const course = rowToCourse(['ECON', 'Econ', '', '', 'chartreuse'], [...COURSE_COLUMNS], 3);
    expect(course?.riskLevel).toBe('green');
  });

  it('leaves the grade empty when the user has not entered one', () => {
    const course = rowToCourse(['ECON', 'Econ'], [...COURSE_COLUMNS], 3);
    // Grades are never invented.
    expect(course?.currentGrade).toBeNull();
  });

  it('round-trips a mastery row and clamps mastery to 0..1', () => {
    const row = rowToMastery(['fractions', '1.7', '10', '4', '', '', ''], [], 2);
    expect(row?.mastery).toBe(1);

    const restored = rowToMastery(masteryToRow(row!), [], 2);
    expect(restored?.concept).toBe('fractions');
    expect(restored?.attempts).toBe(10);
  });
});

describe('runtime config from the CONFIG tab', () => {
  it('uses documented defaults when the tab is empty', () => {
    const config = parseRuntimeConfig({});
    expect(config.timezone).toBe('America/Los_Angeles');
    expect(config.morning_time).toBe('08:00');
    expect(config.quiet_hours_start).toBe('22:30');
    expect(config.quiet_hours_end).toBe('07:30');
    expect(config.top_task_count).toBe(3);
    expect(config.max_study_session_minutes).toBe(50);
    expect(config.minimum_math_minutes).toBe(10);
  });

  it('reads user overrides', () => {
    const config = parseRuntimeConfig({
      morning_time: '7:15',
      top_task_count: '2',
      academic_lock_enabled: 'false',
      career_block_days: 'mon,wed,fri',
    });
    expect(config.morning_time).toBe('07:15');
    expect(config.top_task_count).toBe(2);
    expect(config.academic_lock_enabled).toBe(false);
    expect(config.career_block_days).toEqual([1, 3, 5]);
  });

  it('falls back per-field on nonsense instead of failing wholesale', () => {
    const config = parseRuntimeConfig({
      morning_time: 'banana',
      top_task_count: 'lots',
      quiet_hours_start: '99:99',
      career_block_days: '',
    });
    expect(config.morning_time).toBe(DEFAULT_RUNTIME_CONFIG.morning_time);
    expect(config.top_task_count).toBe(DEFAULT_RUNTIME_CONFIG.top_task_count);
    expect(config.quiet_hours_start).toBe(DEFAULT_RUNTIME_CONFIG.quiet_hours_start);
    expect(config.career_block_days).toEqual(DEFAULT_RUNTIME_CONFIG.career_block_days);
  });

  it('clamps values to a sane range', () => {
    const config = parseRuntimeConfig({ top_task_count: '99', max_study_session_minutes: '9999' });
    expect(config.top_task_count).toBe(5);
    expect(config.max_study_session_minutes).toBe(120);
  });

  it('accepts several ways of writing a boolean', () => {
    for (const truthy of ['true', 'TRUE', 'yes', '1', 'on']) {
      expect(parseRuntimeConfig({ academic_lock_enabled: truthy }).academic_lock_enabled).toBe(true);
    }
    for (const falsy of ['false', 'no', '0', 'off']) {
      expect(parseRuntimeConfig({ academic_lock_enabled: falsy }).academic_lock_enabled).toBe(false);
    }
  });
});

describe('repository contract', () => {
  it('supports partial updates without losing other fields', async () => {
    const repository = new MemoryRepository();
    const now = DateTime.now().setZone(ZONE);

    await repository.createTask({
      id: 't1',
      title: 'Original',
      category: 'academic',
      course: 'CALC',
      dueAt: null,
      estimatedMinutes: 30,
      importance: 4,
      difficulty: 3,
      courseRisk: 'red',
      priorityOverride: null,
      status: 'ready',
      nextAction: 'Open it.',
      source: 'test',
      calendarEventId: null,
      recurrence: null,
      createdAt: now.toISO(),
      completedAt: null,
      snoozedUntil: null,
      lastPromptedAt: null,
      avoidanceCount: 0,
      notes: null,
    });

    const updated = await repository.updateTask('t1', { status: 'completed' });
    expect(updated?.status).toBe('completed');
    expect(updated?.title).toBe('Original');
    expect(updated?.courseRisk).toBe('red');
  });

  it('returns null when updating a task that does not exist', async () => {
    const repository = new MemoryRepository();
    expect(await repository.updateTask('nope', { status: 'completed' })).toBeNull();
  });

  it('keeps the event log append-only', async () => {
    const repository = new MemoryRepository();
    await repository.appendEvent({
      timestamp: '2026-08-12T09:00:00Z',
      eventType: 'command',
      messageId: null,
      command: 'TODAY',
      taskId: null,
      result: 'ok',
      details: null,
    });
    await repository.appendEvent({
      timestamp: '2026-08-12T09:01:00Z',
      eventType: 'command',
      messageId: null,
      command: 'DONE',
      taskId: 't1',
      result: 'ok',
      details: null,
    });
    expect(repository.events).toHaveLength(2);
  });
});
