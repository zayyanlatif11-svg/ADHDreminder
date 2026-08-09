import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { ZONE, course, event } from './helpers.js';
import { parseIcs, parseIcsDate, unfoldIcs, IcsCalendarSource } from '../src/calendar/icsCalendarSource.js';
import { dedupeEvents, CompositeCalendarSource, StaticCalendarSource } from '../src/calendar/compositeCalendarSource.js';
import { classifyEventTitle, detectAssignments, matchCourse } from '../src/calendar/assignmentDetection.js';
import { AppleCalendarSource } from '../src/calendar/appleCalendarSource.js';
import { silentLogger } from '../src/utils/logger.js';

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:assignment-1
SUMMARY:Calc Homework 4 due
DTSTART;TZID=America/Los_Angeles:20260814T235900
DTEND;TZID=America/Los_Angeles:20260814T235900
DESCRIPTION:Sections 3.1-3.4
END:VEVENT
BEGIN:VEVENT
UID:allday-1
SUMMARY:Econ Midterm
DTSTART;VALUE=DATE:20260820
END:VEVENT
BEGIN:VEVENT
UID:recurring-1
SUMMARY:MATH 1A Lecture
DTSTART:20260812T170000Z
DTEND:20260812T181500Z
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR
END:VEVENT
END:VCALENDAR`;

describe('ICS parsing', () => {
  it('unfolds RFC 5545 continuation lines', () => {
    const lines = unfoldIcs('SUMMARY:A very long\r\n  title that wrapped');
    expect(lines[0]).toBe('SUMMARY:A very long title that wrapped');
  });

  it('parses zoned, UTC, and date-only timestamps', () => {
    const zoned = parseIcsDate('DTSTART;TZID=America/Los_Angeles', '20260814T235900', ZONE);
    expect(zoned?.allDay).toBe(false);

    const utc = parseIcsDate('DTSTART', '20260812T170000Z', ZONE);
    expect(utc?.date.toISOString()).toBe('2026-08-12T17:00:00.000Z');

    const dateOnly = parseIcsDate('DTSTART;VALUE=DATE', '20260820', ZONE);
    expect(dateOnly?.allDay).toBe(true);
  });

  it('returns null on unparseable dates rather than guessing', () => {
    expect(parseIcsDate('DTSTART', 'not-a-date', ZONE)).toBeNull();
  });

  it('extracts events and flags recurring ones', () => {
    const events = parseIcs(SAMPLE_ICS, ZONE);
    expect(events).toHaveLength(3);

    const homework = events.find((e) => e.uid === 'assignment-1');
    expect(homework?.summary).toBe('Calc Homework 4 due');
    expect(homework?.description).toBe('Sections 3.1-3.4');

    const recurring = events.find((e) => e.uid === 'recurring-1');
    expect(recurring?.hasRrule).toBe(true);
  });

  it('gives an all-day event a real span instead of zero length', () => {
    const allDay = parseIcs(SAMPLE_ICS, ZONE).find((e) => e.uid === 'allday-1');
    expect(allDay?.allDay).toBe(true);
    expect(allDay!.end.getTime()).toBeGreaterThan(allDay!.start.getTime());
  });

  it('survives a malformed feed without throwing', () => {
    expect(() => parseIcs('total garbage', ZONE)).not.toThrow();
    expect(parseIcs('total garbage', ZONE)).toEqual([]);
    expect(parseIcs('BEGIN:VEVENT\nEND:VEVENT', ZONE)).toEqual([]);
  });

  it('skips recurring events rather than inventing occurrences', async () => {
    const source = new IcsCalendarSource({
      sources: ['https://example.test/feed.ics'],
      logger: silentLogger,
      timezone: ZONE,
      fetchImpl: (async () => new Response(SAMPLE_ICS, { status: 200 })) as typeof fetch,
    });

    const events = await source.listEvents(
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(events.map((e) => e.title)).not.toContain('MATH 1A Lecture');
    expect(events.map((e) => e.title)).toContain('Calc Homework 4 due');
  });

  it('reports unreachable feeds as unhealthy without throwing', async () => {
    const source = new IcsCalendarSource({
      sources: ['https://example.test/missing.ics'],
      logger: silentLogger,
      timezone: ZONE,
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    });

    expect(await source.listEvents(new Date(), new Date())).toEqual([]);
    expect((await source.healthCheck()).ok).toBe(false);
  });
});

describe('merging multiple calendar sources', () => {
  it('collapses the same event appearing in Google and Apple', () => {
    const fromGoogle = event('MATH 1A', '2026-08-12T10:00:00', '2026-08-12T11:15:00', {
      id: 'google:a',
      source: 'google',
    });
    const fromApple = event('MATH 1A', '2026-08-12T10:00:00', '2026-08-12T11:15:00', {
      id: 'apple:b',
      source: 'apple',
    });

    const merged = dedupeEvents([fromApple, fromGoogle]);
    expect(merged).toHaveLength(1);
    // Google wins the tie so the retained id is stable across runs.
    expect(merged[0]?.source).toBe('google');
  });

  it('keeps genuinely different events', () => {
    const a = event('MATH 1A', '2026-08-12T10:00:00', '2026-08-12T11:15:00');
    const b = event('ECON 1', '2026-08-12T13:00:00', '2026-08-12T14:15:00');
    expect(dedupeEvents([a, b])).toHaveLength(2);
  });

  it('returns merged events in chronological order', () => {
    const later = event('Later', '2026-08-12T15:00:00', '2026-08-12T16:00:00');
    const earlier = event('Earlier', '2026-08-12T09:00:00', '2026-08-12T10:00:00');
    expect(dedupeEvents([later, earlier]).map((e) => e.title)).toEqual(['Earlier', 'Later']);
  });

  it('keeps working when one backend fails', async () => {
    const working = new StaticCalendarSource([
      event('Works', '2026-08-12T10:00:00', '2026-08-12T11:00:00'),
    ]);
    const broken = {
      id: 'apple' as const,
      listEvents: async () => {
        throw new Error('osascript exploded');
      },
      healthCheck: async () => ({ id: 'apple' as const, ok: false, detail: 'broken' }),
    };

    const composite = new CompositeCalendarSource([working, broken], silentLogger);
    const events = await composite.listEvents(
      new Date('2026-08-12T00:00:00Z'),
      new Date('2026-08-13T00:00:00Z'),
    );

    expect(events).toHaveLength(1);
    // Degraded, but still usable.
    expect((await composite.healthCheck()).ok).toBe(true);
  });

  it('is unhealthy only when every backend is down', async () => {
    const broken = {
      id: 'ics' as const,
      listEvents: async () => [],
      healthCheck: async () => ({ id: 'ics' as const, ok: false, detail: 'down' }),
    };
    const composite = new CompositeCalendarSource([broken], silentLogger);
    expect((await composite.healthCheck()).ok).toBe(false);
  });
});

describe('Apple Calendar adapter', () => {
  it('maps EventKit output into the shared event shape', async () => {
    const source = new AppleCalendarSource({
      calendarNames: [],
      logger: silentLogger,
      runScript: async () =>
        JSON.stringify({
          ok: true,
          events: [
            {
              id: 'ABC-123',
              title: 'MMA training',
              start: 1786000000,
              end: 1786005400,
              allDay: false,
              calendarName: 'Personal',
              location: 'Gym',
              description: null,
              availability: 0,
            },
          ],
        }),
    });

    const events = await source.listEvents(new Date(0), new Date(Date.now() + 1e10));
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('apple:ABC-123');
    expect(events[0]?.source).toBe('apple');
    expect(events[0]?.calendarName).toBe('Personal');
  });

  it('marks EventKit "free" events as non-blocking', async () => {
    const source = new AppleCalendarSource({
      calendarNames: [],
      logger: silentLogger,
      runScript: async () =>
        JSON.stringify({
          ok: true,
          events: [
            {
              id: 'free-1',
              title: 'Optional',
              start: 1786000000,
              end: 1786005400,
              allDay: false,
              calendarName: 'Personal',
              location: null,
              description: null,
              availability: 1,
            },
          ],
        }),
    });

    const events = await source.listEvents(new Date(0), new Date(Date.now() + 1e10));
    expect(events[0]?.transparent).toBe(true);
  });

  it('degrades to an empty schedule when macOS has not granted access', async () => {
    const source = new AppleCalendarSource({
      calendarNames: [],
      logger: silentLogger,
      runScript: async () => JSON.stringify({ ok: false, reason: 'not_authorized', status: 0 }),
    });

    expect(await source.listEvents(new Date(0), new Date())).toEqual([]);
    const health = await source.healthCheck();
    // Only meaningful on macOS; elsewhere it reports the platform mismatch.
    expect(health.ok).toBe(false);
    expect(health.detail.length).toBeGreaterThan(0);
  });

  it('does not throw when osascript fails outright', async () => {
    const source = new AppleCalendarSource({
      calendarNames: [],
      logger: silentLogger,
      runScript: async () => {
        throw new Error('osascript: command not found');
      },
    });
    await expect(source.listEvents(new Date(0), new Date())).resolves.toEqual([]);
  });
});

describe('assignment detection', () => {
  const courses = [
    course({ courseId: 'CALC', name: 'Calculus I', calendarId: 'MATH 1A', riskLevel: 'red' }),
    course({ courseId: 'ECON', name: 'Microeconomics', calendarId: 'ECON 1', riskLevel: 'green' }),
  ];

  it('recognises assignment-shaped titles', () => {
    expect(classifyEventTitle('Homework 4 due')?.kind).toBe('assignment');
    expect(classifyEventTitle('Midterm Exam')?.kind).toBe('exam');
    expect(classifyEventTitle('Final Project')?.kind).toBe('exam');
    expect(classifyEventTitle('Quiz 2')?.kind).toBe('quiz');
  });

  it('does not treat class meetings or office hours as tasks', () => {
    expect(classifyEventTitle('MATH 1A Lecture')).toBeNull();
    expect(classifyEventTitle('Office Hours')).toBeNull();
    expect(classifyEventTitle('Study group')).toBeNull();
    expect(classifyEventTitle('Spring Break — no class')).toBeNull();
  });

  it('does not treat an arbitrary calendar event as a task', () => {
    expect(classifyEventTitle('Dentist')).toBeNull();
    expect(classifyEventTitle('MMA training')).toBeNull();
    expect(classifyEventTitle('Lunch with Sam')).toBeNull();
  });

  it('matches an event to its course by calendar name', () => {
    const homework = event('Homework 4 due', '2026-08-14T23:00:00', '2026-08-14T23:59:00', {
      calendarName: 'MATH 1A',
    });
    expect(matchCourse(homework, courses)?.courseId).toBe('CALC');
  });

  it('imports only assignments on course-linked calendars', () => {
    const events = [
      event('Homework 4 due', '2026-08-14T23:00:00', '2026-08-14T23:59:00', { calendarName: 'MATH 1A' }),
      event('Homework due', '2026-08-14T23:00:00', '2026-08-14T23:59:00', { calendarName: 'Random Calendar' }),
    ];

    const detected = detectAssignments(events, courses);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.courseId).toBe('CALC');
  });

  it('raises importance for an assignment on a red-risk course', () => {
    const events = [
      event('Homework 4 due', '2026-08-14T23:00:00', '2026-08-14T23:59:00', { calendarName: 'MATH 1A' }),
      event('Homework 4 due', '2026-08-14T23:00:00', '2026-08-14T23:59:00', { calendarName: 'ECON 1' }),
    ];
    const detected = detectAssignments(events, courses);
    const calc = detected.find((d) => d.courseId === 'CALC');
    const econ = detected.find((d) => d.courseId === 'ECON');
    expect(calc!.importance).toBeGreaterThan(econ!.importance);
  });

  it('treats an all-day due date as end of day, not midnight', () => {
    const allDay = event('Essay due', '2026-08-14T00:00:00', '2026-08-15T00:00:00', {
      calendarName: 'ECON 1',
      allDay: true,
    });
    const detected = detectAssignments([allDay], courses);
    // Must be checked in the user's zone — the test runner's local time is not
    // necessarily America/Los_Angeles.
    const dueLocal = DateTime.fromJSDate(detected[0]!.dueAt, { zone: ZONE });
    expect(dueLocal.hour).toBeGreaterThan(12);
    expect(dueLocal.day).toBe(14);
  });

  it('can be widened to unlinked calendars when the user opts in', () => {
    const events = [
      event('Homework due', '2026-08-14T23:00:00', '2026-08-14T23:59:00', { calendarName: 'Random' }),
    ];
    expect(detectAssignments(events, courses)).toHaveLength(0);
    expect(detectAssignments(events, courses, { allowUnlinkedCalendars: true })).toHaveLength(1);
  });
});
