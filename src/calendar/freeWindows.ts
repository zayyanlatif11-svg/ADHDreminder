import { DateTime } from 'luxon';
import type { CalendarEvent } from './types.js';
import { type TimeWindow, windowMinutes } from '../utils/time.js';

export interface FreeWindowOptions {
  /** Do not consider time before this instant. */
  from: DateTime;
  /** Do not consider time after this instant. */
  to: DateTime;
  /** Quiet hours boundaries, used to stop suggesting work at 2am. */
  dayStart?: string;
  dayEnd?: string;
  /** Windows shorter than this are not worth naming. */
  minimumMinutes?: number;
}

/**
 * All-day events (a "Midterm week" banner, a holiday) mark a day, they do not
 * consume it. Treating them as busy would leave the user with zero free time.
 */
function isBlocking(event: CalendarEvent): boolean {
  if (event.allDay) return false;
  if (event.transparent) return false;
  return event.end > event.start;
}

export function busyIntervals(events: CalendarEvent[], zone: string): TimeWindow[] {
  const blocking = events
    .filter(isBlocking)
    .map((event) => ({
      start: DateTime.fromJSDate(event.start, { zone }),
      end: DateTime.fromJSDate(event.end, { zone }),
    }))
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const merged: TimeWindow[] = [];
  for (const interval of blocking) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * Computes the gaps a person could actually work in, clipped to waking hours.
 */
export function computeFreeWindows(
  events: CalendarEvent[],
  zone: string,
  options: FreeWindowOptions,
): TimeWindow[] {
  const minimum = options.minimumMinutes ?? 10;

  let cursor = options.from;
  let limit = options.to;

  // Clip to the waking day so the agent never proposes a 03:00 study block.
  if (options.dayStart) {
    const [h, m] = options.dayStart.split(':').map(Number);
    const wakeUp = options.from.startOf('day').set({ hour: h ?? 7, minute: m ?? 30 });
    if (cursor < wakeUp) cursor = wakeUp;
  }
  if (options.dayEnd) {
    const [h, m] = options.dayEnd.split(':').map(Number);
    const bedtime = options.from.startOf('day').set({ hour: h ?? 22, minute: m ?? 30 });
    // A quiet-hours start before the wake time means it wraps past midnight.
    if (bedtime > cursor && bedtime < limit) limit = bedtime;
  }

  if (cursor >= limit) return [];

  const busy = busyIntervals(events, zone);
  const free: TimeWindow[] = [];

  for (const interval of busy) {
    if (interval.end <= cursor) continue;
    if (interval.start >= limit) break;
    if (interval.start > cursor) {
      free.push({ start: cursor, end: interval.start < limit ? interval.start : limit });
    }
    if (interval.end > cursor) cursor = interval.end;
    if (cursor >= limit) break;
  }
  if (cursor < limit) free.push({ start: cursor, end: limit });

  return free.filter((window) => windowMinutes(window) >= minimum);
}

/**
 * The window the user is in right now — the basis of WHAT NOW. Returns null
 * when the user is currently in a meeting or class.
 */
export function currentFreeWindow(
  events: CalendarEvent[],
  zone: string,
  now: DateTime,
  endOfDay: DateTime,
  dayEnd?: string,
): TimeWindow | null {
  const windows = computeFreeWindows(events, zone, {
    from: now,
    to: endOfDay,
    dayEnd,
    minimumMinutes: 1,
  });
  const first = windows[0];
  if (!first) return null;
  // Only counts as "now" if it has already begun (within a 2-minute grace).
  return first.start <= now.plus({ minutes: 2 }) ? { start: now, end: first.end } : null;
}

/** The next fixed commitment after `now`, used for "you have 42 minutes before class". */
export function nextFixedEvent(
  events: CalendarEvent[],
  zone: string,
  now: DateTime,
): CalendarEvent | null {
  const upcoming = events
    .filter(isBlocking)
    .filter((event) => DateTime.fromJSDate(event.start, { zone }) > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return upcoming[0] ?? null;
}

export function totalFreeMinutes(windows: TimeWindow[]): number {
  return windows.reduce((sum, window) => sum + windowMinutes(window), 0);
}
