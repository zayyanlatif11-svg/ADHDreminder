import fs from 'node:fs/promises';
import path from 'node:path';
import { DateTime } from 'luxon';
import type { Logger } from '../utils/logger.js';
import type { CalendarEvent, CalendarSource, CalendarSourceStatus } from './types.js';

/**
 * Minimal iCalendar reader for feed URLs and local .ics files.
 *
 * This is the extension point the spec calls for: a Canvas assignment feed, a
 * published iCloud calendar, or any school portal that exports .ics can be
 * plugged in without touching the rest of the app. It intentionally supports
 * only the subset needed for scheduling — VEVENT with DTSTART/DTEND/SUMMARY —
 * and skips anything it cannot understand rather than guessing.
 *
 * Recurrence (RRULE) is deliberately NOT expanded: silently inventing events is
 * worse than omitting them. Recurring class meetings should come from Google or
 * Apple Calendar, which expand recurrence properly.
 */

interface ParsedEvent {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string | null;
  description: string | null;
  hasRrule: boolean;
}

/** Undoes RFC 5545 line folding (continuation lines begin with a space or tab). */
export function unfoldIcs(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Parses DTSTART/DTEND in the three forms that appear in the wild:
 *   20260812T143000Z        — UTC
 *   TZID=America/Los_Angeles:20260812T143000 — zoned
 *   20260812                — date only (all-day)
 */
export function parseIcsDate(
  property: string,
  value: string,
  fallbackZone: string,
): { date: Date; allDay: boolean } | null {
  const tzMatch = /TZID=([^;:]+)/i.exec(property);
  const zone = tzMatch?.[1] ?? fallbackZone;
  const trimmed = value.trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const dt = DateTime.fromObject(
      { year: Number(dateOnly[1]), month: Number(dateOnly[2]), day: Number(dateOnly[3]) },
      { zone },
    );
    return dt.isValid ? { date: dt.toJSDate(), allDay: true } : null;
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(trimmed);
  if (dateTime) {
    const dt = DateTime.fromObject(
      {
        year: Number(dateTime[1]),
        month: Number(dateTime[2]),
        day: Number(dateTime[3]),
        hour: Number(dateTime[4]),
        minute: Number(dateTime[5]),
        second: Number(dateTime[6]),
      },
      { zone: dateTime[7] === 'Z' ? 'utc' : zone },
    );
    return dt.isValid ? { date: dt.toJSDate(), allDay: false } : null;
  }
  return null;
}

export function parseIcs(raw: string, fallbackZone: string): ParsedEvent[] {
  const lines = unfoldIcs(raw);
  const events: ParsedEvent[] = [];
  let current: Partial<ParsedEvent> & { startInfo?: { date: Date; allDay: boolean } } = {};
  let inEvent = false;

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      inEvent = true;
      current = { hasRrule: false };
      continue;
    }
    if (line.startsWith('END:VEVENT')) {
      if (inEvent && current.start && current.summary !== undefined) {
        // A missing DTEND means a zero-length or all-day event; give it a
        // sensible span so it can still occupy time.
        const end =
          current.end ??
          new Date(current.start.getTime() + (current.allDay ? 24 * 3600_000 : 3600_000));
        events.push({
          uid: current.uid ?? `${current.summary}-${current.start.toISOString()}`,
          summary: current.summary,
          start: current.start,
          end,
          allDay: current.allDay ?? false,
          location: current.location ?? null,
          description: current.description ?? null,
          hasRrule: current.hasRrule ?? false,
        });
      }
      inEvent = false;
      current = {};
      continue;
    }
    if (!inEvent) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const property = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const name = (property.split(';')[0] ?? '').toUpperCase();

    switch (name) {
      case 'UID':
        current.uid = value.trim();
        break;
      case 'SUMMARY':
        current.summary = unescapeText(value).trim();
        break;
      case 'LOCATION':
        current.location = unescapeText(value).trim();
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(value).trim();
        break;
      case 'RRULE':
        current.hasRrule = true;
        break;
      case 'DTSTART': {
        const parsed = parseIcsDate(property, value, fallbackZone);
        if (parsed) {
          current.start = parsed.date;
          current.allDay = parsed.allDay;
        }
        break;
      }
      case 'DTEND': {
        const parsed = parseIcsDate(property, value, fallbackZone);
        if (parsed) current.end = parsed.date;
        break;
      }
      default:
        break;
    }
  }
  return events;
}

export interface IcsCalendarOptions {
  /** http(s) URLs or local file paths. */
  sources: string[];
  logger: Logger;
  timezone: string;
  fetchImpl?: typeof fetch;
  /** Feeds change rarely; caching avoids hammering a school server. */
  cacheMs?: number;
}

export class IcsCalendarSource implements CalendarSource {
  readonly id = 'ics' as const;
  private readonly sources: string[];
  private readonly log: Logger;
  private readonly timezone: string;
  private readonly doFetch: typeof fetch;
  private readonly cacheMs: number;
  private readonly cache = new Map<string, { at: number; raw: string }>();

  constructor(options: IcsCalendarOptions) {
    this.sources = options.sources;
    this.log = options.logger.child({ module: 'calendar:ics' });
    this.timezone = options.timezone;
    this.doFetch = options.fetchImpl ?? fetch;
    this.cacheMs = options.cacheMs ?? 15 * 60_000;
  }

  private async load(source: string): Promise<string | null> {
    const cached = this.cache.get(source);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.raw;

    try {
      let raw: string;
      if (/^https?:\/\//i.test(source)) {
        const response = await this.doFetch(source, {
          signal: AbortSignal.timeout(20_000),
          headers: { accept: 'text/calendar, text/plain' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        raw = await response.text();
      } else if (/^webcal:\/\//i.test(source)) {
        return this.load(source.replace(/^webcal:/i, 'https:'));
      } else {
        raw = await fs.readFile(path.resolve(source), 'utf8');
      }
      this.cache.set(source, { at: Date.now(), raw });
      return raw;
    } catch (error) {
      this.log.warn(
        { source, error: error instanceof Error ? error.message : String(error) },
        'failed to load ICS feed',
      );
      return null;
    }
  }

  private static nameFor(source: string): string {
    try {
      return /^https?:\/\//i.test(source)
        ? (new URL(source).hostname ?? 'ICS feed')
        : path.basename(source, '.ics');
    } catch {
      return 'ICS feed';
    }
  }

  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let skippedRecurring = 0;

    for (const source of this.sources) {
      const raw = await this.load(source);
      if (raw === null) continue;
      const calendarName = IcsCalendarSource.nameFor(source);

      for (const event of parseIcs(raw, this.timezone)) {
        if (event.hasRrule) {
          skippedRecurring += 1;
          continue;
        }
        if (event.end <= from || event.start >= to) continue;
        out.push({
          id: `ics:${calendarName}:${event.uid}`,
          title: event.summary,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          calendarName,
          source: 'ics',
          location: event.location,
          description: event.description,
        });
      }
    }

    if (skippedRecurring > 0) {
      this.log.info(
        { skippedRecurring },
        'skipped recurring ICS events (RRULE is not expanded; use Google/Apple for recurring classes)',
      );
    }
    return out;
  }

  async healthCheck(): Promise<CalendarSourceStatus> {
    if (this.sources.length === 0) {
      return { id: this.id, ok: false, detail: 'No ICS_CALENDAR_URLS configured' };
    }
    let reachable = 0;
    for (const source of this.sources) {
      if ((await this.load(source)) !== null) reachable += 1;
    }
    return {
      id: this.id,
      ok: reachable > 0,
      detail:
        reachable === this.sources.length
          ? 'All ICS feeds reachable'
          : `${reachable}/${this.sources.length} ICS feeds reachable`,
      calendarsFound: reachable,
    };
  }
}
