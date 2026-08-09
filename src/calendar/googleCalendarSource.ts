import { google, type calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { DateTime } from 'luxon';
import type { Logger } from '../utils/logger.js';
import type {
  CalendarEvent,
  CalendarSource,
  CalendarSourceStatus,
  StudyBlockRequest,
  StudyBlockWriter,
} from './types.js';

export interface GoogleCalendarOptions {
  auth: OAuth2Client;
  /** Empty means "primary". */
  calendarIds: string[];
  logger: Logger;
  timezone: string;
}

function toDate(value: calendar_v3.Schema$EventDateTime | undefined, fallback: Date): Date {
  if (value?.dateTime) {
    const parsed = new Date(value.dateTime);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (value?.date) {
    const parsed = new Date(`${value.date}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

export class GoogleCalendarSource implements CalendarSource, StudyBlockWriter {
  readonly id = 'google' as const;
  private readonly api: calendar_v3.Calendar;
  private readonly calendarIds: string[];
  private readonly log: Logger;
  private readonly timezone: string;

  constructor(options: GoogleCalendarOptions) {
    this.api = google.calendar({ version: 'v3', auth: options.auth });
    this.calendarIds = options.calendarIds.length > 0 ? options.calendarIds : ['primary'];
    this.log = options.logger.child({ module: 'calendar:google' });
    this.timezone = options.timezone;
  }

  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    for (const calendarId of this.calendarIds) {
      try {
        const response = await this.api.events.list({
          calendarId,
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250,
        });
        const calendarName = response.data.summary ?? calendarId;
        for (const item of response.data.items ?? []) {
          // Declined invitations are not real commitments.
          const selfAttendee = (item.attendees ?? []).find((a) => a.self);
          if (selfAttendee?.responseStatus === 'declined') continue;
          if (item.status === 'cancelled') continue;

          const start = toDate(item.start, new Date(from));
          const end = toDate(item.end, new Date(start.getTime() + 60 * 60_000));
          events.push({
            id: `google:${calendarId}:${item.id ?? `${start.toISOString()}`}`,
            title: item.summary ?? '(untitled)',
            start,
            end,
            allDay: Boolean(item.start?.date && !item.start?.dateTime),
            calendarName,
            source: 'google',
            location: item.location ?? null,
            description: item.description ?? null,
            transparent: item.transparency === 'transparent',
          });
        }
      } catch (error) {
        // One unreadable calendar must not blank out the whole schedule.
        this.log.warn(
          { calendarId, error: error instanceof Error ? error.message : String(error) },
          'failed to read calendar',
        );
      }
    }
    return events;
  }

  async healthCheck(): Promise<CalendarSourceStatus> {
    try {
      const response = await this.api.calendarList.list({ maxResults: 100 });
      return {
        id: this.id,
        ok: true,
        detail: 'Google Calendar reachable',
        calendarsFound: response.data.items?.length ?? 0,
      };
    } catch (error) {
      return {
        id: this.id,
        ok: false,
        detail: error instanceof Error ? error.message : 'Google Calendar unreachable',
      };
    }
  }

  /** Lists calendars so setup can show the user their real calendar IDs. */
  async listCalendars(): Promise<Array<{ id: string; summary: string; primary: boolean }>> {
    const response = await this.api.calendarList.list({ maxResults: 250 });
    return (response.data.items ?? []).map((item) => ({
      id: item.id ?? '',
      summary: item.summary ?? '(unnamed)',
      primary: Boolean(item.primary),
    }));
  }

  // ---- StudyBlockWriter --------------------------------------------------
  // Writes are confined to a calendar this agent creates and owns.

  private agentCalendarId: string | null = null;

  async ensureCalendar(name: string): Promise<string> {
    if (this.agentCalendarId) return this.agentCalendarId;
    const list = await this.api.calendarList.list({ maxResults: 250 });
    const existing = (list.data.items ?? []).find((item) => item.summary === name);
    if (existing?.id) {
      this.agentCalendarId = existing.id;
      return existing.id;
    }
    const created = await this.api.calendars.insert({
      requestBody: { summary: name, timeZone: this.timezone },
    });
    const id = created.data.id;
    if (!id) throw new Error(`Could not create the "${name}" calendar`);
    this.log.info({ name, id }, 'created dedicated agent calendar');
    this.agentCalendarId = id;
    return id;
  }

  /**
   * Guard rail: every write path resolves the calendar by name through
   * `ensureCalendar` and refuses an id that is not the agent's own calendar.
   */
  private async assertAgentCalendar(name: string, calendarId: string): Promise<void> {
    const owned = await this.ensureCalendar(name);
    if (owned !== calendarId) {
      throw new Error('Refusing to modify a calendar other than the agent calendar');
    }
  }

  async listAgentBlocks(name: string, from: Date, to: Date): Promise<CalendarEvent[]> {
    const calendarId = await this.ensureCalendar(name);
    const response = await this.api.events.list({
      calendarId,
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });
    return (response.data.items ?? []).map((item) => {
      const start = toDate(item.start, from);
      return {
        id: item.id ?? '',
        title: item.summary ?? '',
        start,
        end: toDate(item.end, new Date(start.getTime() + 30 * 60_000)),
        allDay: false,
        calendarName: name,
        source: 'google' as const,
        description: item.description ?? null,
      };
    });
  }

  async createBlock(name: string, block: StudyBlockRequest): Promise<string | null> {
    const calendarId = await this.ensureCalendar(name);
    await this.assertAgentCalendar(name, calendarId);
    const response = await this.api.events.insert({
      calendarId,
      requestBody: {
        summary: block.title,
        description: block.description ?? 'Generated by execution-agent',
        start: { dateTime: block.start.toISO() ?? undefined, timeZone: this.timezone },
        end: { dateTime: block.end.toISO() ?? undefined, timeZone: this.timezone },
        transparency: 'opaque',
      },
    });
    return response.data.id ?? null;
  }

  async deleteBlock(name: string, eventId: string): Promise<boolean> {
    const calendarId = await this.ensureCalendar(name);
    await this.assertAgentCalendar(name, calendarId);
    try {
      await this.api.events.delete({ calendarId, eventId });
      return true;
    } catch {
      return false;
    }
  }
}

/** Convenience for building a Luxon DateTime in the agent's zone. */
export function zoned(date: Date, zone: string): DateTime {
  return DateTime.fromJSDate(date, { zone });
}
