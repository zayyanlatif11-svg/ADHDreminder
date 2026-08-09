import { DateTime, Interval } from 'luxon';

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** A frozen clock for deterministic tests/simulation. */
export function fixedClock(iso: string, zone = 'America/Los_Angeles'): Clock {
  const dt = DateTime.fromISO(iso, { zone });
  if (!dt.isValid) throw new Error(`fixedClock: invalid ISO "${iso}" (${dt.invalidReason})`);
  const at = dt.toJSDate();
  return () => new Date(at);
}

export function nowIn(zone: string, clock: Clock = systemClock): DateTime {
  return DateTime.fromJSDate(clock(), { zone });
}

export function toZone(date: Date | string, zone: string): DateTime {
  return typeof date === 'string'
    ? DateTime.fromISO(date, { zone })
    : DateTime.fromJSDate(date, { zone });
}

/** Local calendar date key, e.g. "2026-08-09". Used for once-per-day guards. */
export function dayKey(dt: DateTime): string {
  return dt.toFormat('yyyy-LL-dd');
}

/** "SATURDAY" — used in the morning message header. */
export function weekdayHeader(dt: DateTime): string {
  return dt.toFormat('cccc').toUpperCase();
}

/**
 * Parses "HH:mm" into minutes-since-midnight. Returns null for junk so callers
 * can fall back to a default rather than crashing on a bad Sheet value.
 */
export function parseClockTime(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function minutesSinceMidnight(dt: DateTime): number {
  return dt.hour * 60 + dt.minute;
}

/**
 * Quiet hours may wrap midnight (22:30 → 07:30), so the comparison is a union
 * of two ranges rather than a simple between().
 */
export function isWithinQuietHours(
  dt: DateTime,
  quietStart: string,
  quietEnd: string,
): boolean {
  const start = parseClockTime(quietStart);
  const end = parseClockTime(quietEnd);
  if (start === null || end === null) return false;
  const current = minutesSinceMidnight(dt);
  if (start === end) return false;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function setTimeOnDay(day: DateTime, hhmm: string, fallbackMinutes = 8 * 60): DateTime {
  const minutes = parseClockTime(hhmm) ?? fallbackMinutes;
  return day.startOf('day').plus({ minutes });
}

export function humanDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Deadline phrasing tuned to be informative without inducing panic:
 * no "OVERDUE BY 14 DAYS" style shaming.
 */
export function relativeDueLabel(due: DateTime, now: DateTime): string {
  const diffHours = due.diff(now, 'hours').hours;
  if (diffHours < 0) return 'past due';
  if (diffHours < 12 && due.hasSame(now, 'day')) return 'due today';
  if (due.hasSame(now.plus({ days: 1 }), 'day')) return 'due tomorrow';
  if (diffHours < 24) return 'due in <24h';
  const days = Math.ceil(diffHours / 24);
  if (days <= 7) return `due in ${days}d`;
  return `due ${due.toFormat('LLL d')}`;
}

export interface TimeWindow {
  start: DateTime;
  end: DateTime;
}

export function windowMinutes(window: TimeWindow): number {
  return Math.max(0, Math.round(window.end.diff(window.start, 'minutes').minutes));
}

export function toInterval(window: TimeWindow): Interval {
  return Interval.fromDateTimes(window.start, window.end);
}

export function overlaps(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}
