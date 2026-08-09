import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { Logger } from '../utils/logger.js';
import type {
  CalendarEvent,
  CalendarSource,
  CalendarSourceStatus,
  StudyBlockRequest,
  StudyBlockWriter,
} from './types.js';
import {
  CREATE_EVENT_SCRIPT,
  DELETE_EVENT_SCRIPT,
  ENSURE_CALENDAR_SCRIPT,
  LIST_CALENDARS_SCRIPT,
  LIST_EVENTS_SCRIPT,
} from './appleCalendarScripts.js';

const execFileAsync = promisify(execFile);

export interface AppleCalendarOptions {
  /** Calendar names to read. Empty = every calendar Calendar.app knows about. */
  calendarNames: string[];
  logger: Logger;
  /** Injectable for tests; defaults to running real osascript. */
  runScript?: (script: string, params: unknown) => Promise<string>;
  timeoutMs?: number;
}

export interface AppleCalendarInfo {
  title: string;
  identifier: string;
  writable: boolean;
  type: string;
}

/** EventKit availability constant meaning "shows as free". */
const EK_AVAILABILITY_FREE = 1;

export function isMacOs(): boolean {
  return os.platform() === 'darwin';
}

/**
 * Reads the macOS Calendar database through EventKit.
 *
 * This picks up every account Calendar.app is signed into — iCloud, a Google
 * account added to macOS, Exchange, and subscribed .ics feeds — which is why it
 * complements rather than duplicates the Google source.
 */
export class AppleCalendarSource implements CalendarSource, StudyBlockWriter {
  readonly id = 'apple' as const;
  private readonly calendarNames: string[];
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly runScript: (script: string, params: unknown) => Promise<string>;
  /**
   * The macOS-only guard protects the *default* runner, which shells out to
   * osascript. An injected runner is by definition not osascript, so it must
   * not be gated on the platform — otherwise the adapter is untestable
   * anywhere but a Mac.
   */
  private readonly requiresMacOs: boolean;

  constructor(options: AppleCalendarOptions) {
    this.calendarNames = options.calendarNames;
    this.log = options.logger.child({ module: 'calendar:apple' });
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.requiresMacOs = options.runScript === undefined;
    this.runScript = options.runScript ?? ((script, params) => this.osascript(script, params));
  }

  /**
   * Parameters travel in an environment variable, never interpolated into the
   * script text, so a calendar name containing quotes cannot alter the program.
   */
  private async osascript(script: string, params: unknown): Promise<string> {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: this.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, EA_PARAMS: JSON.stringify(params ?? {}) },
    });
    return stdout;
  }

  private async call<T>(script: string, params: unknown): Promise<T | null> {
    if (this.requiresMacOs && !isMacOs()) {
      this.log.debug({}, 'Apple Calendar is only available on macOS — skipping');
      return null;
    }
    try {
      const stdout = await this.runScript(script, params);
      const trimmed = stdout.trim();
      if (trimmed === '') return null;
      return JSON.parse(trimmed) as T;
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'osascript call failed',
      );
      return null;
    }
  }

  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const result = await this.call<{
      ok: boolean;
      reason?: string;
      events?: Array<{
        id: string;
        title: string;
        start: number;
        end: number;
        allDay: boolean;
        calendarName: string;
        location: string | null;
        description: string | null;
        availability?: number;
      }>;
    }>(LIST_EVENTS_SCRIPT, {
      from: Math.floor(from.getTime() / 1000),
      to: Math.floor(to.getTime() / 1000),
      calendarNames: this.calendarNames,
    });

    if (!result?.ok) {
      if (result?.reason === 'not_authorized') {
        this.log.warn(
          {},
          'macOS has not granted Calendar access. System Settings > Privacy & Security > Calendars.',
        );
      }
      return [];
    }

    return (result.events ?? []).map((event) => ({
      id: `apple:${event.id}`,
      title: event.title,
      start: new Date(event.start * 1000),
      end: new Date(event.end * 1000),
      allDay: Boolean(event.allDay),
      calendarName: event.calendarName,
      source: 'apple' as const,
      location: event.location,
      description: event.description,
      transparent: event.availability === EK_AVAILABILITY_FREE,
    }));
  }

  async healthCheck(): Promise<CalendarSourceStatus> {
    if (this.requiresMacOs && !isMacOs()) {
      return { id: this.id, ok: false, detail: 'Apple Calendar requires macOS' };
    }
    const result = await this.call<{
      ok: boolean;
      reason?: string;
      calendars?: AppleCalendarInfo[];
    }>(LIST_CALENDARS_SCRIPT, {});

    if (!result) {
      return { id: this.id, ok: false, detail: 'osascript did not respond' };
    }
    if (!result.ok) {
      return {
        id: this.id,
        ok: false,
        detail:
          result.reason === 'not_authorized'
            ? 'Calendar access not granted. Approve it in System Settings > Privacy & Security > Calendars.'
            : `Apple Calendar error: ${result.reason ?? 'unknown'}`,
      };
    }
    return {
      id: this.id,
      ok: true,
      detail: 'Apple Calendar reachable',
      calendarsFound: result.calendars?.length ?? 0,
    };
  }

  async listCalendars(): Promise<AppleCalendarInfo[]> {
    const result = await this.call<{ ok: boolean; calendars?: AppleCalendarInfo[] }>(
      LIST_CALENDARS_SCRIPT,
      {},
    );
    return result?.ok ? (result.calendars ?? []) : [];
  }

  // ---- StudyBlockWriter --------------------------------------------------

  async ensureCalendar(name: string): Promise<string> {
    const result = await this.call<{ ok: boolean; identifier?: string; reason?: string }>(
      ENSURE_CALENDAR_SCRIPT,
      { name },
    );
    if (!result?.ok || !result.identifier) {
      throw new Error(
        `Could not create the "${name}" calendar in Apple Calendar: ${result?.reason ?? 'unknown error'}`,
      );
    }
    return result.identifier;
  }

  async listAgentBlocks(name: string, from: Date, to: Date): Promise<CalendarEvent[]> {
    const source = new AppleCalendarSource({
      calendarNames: [name],
      logger: this.log,
      runScript: this.runScript,
      timeoutMs: this.timeoutMs,
    });
    return source.listEvents(from, to);
  }

  async createBlock(name: string, block: StudyBlockRequest): Promise<string | null> {
    await this.ensureCalendar(name);
    const result = await this.call<{ ok: boolean; identifier?: string; reason?: string }>(
      CREATE_EVENT_SCRIPT,
      {
        calendarName: name,
        title: block.title,
        description: block.description ?? 'Generated by execution-agent',
        start: Math.floor(block.start.toSeconds()),
        end: Math.floor(block.end.toSeconds()),
      },
    );
    if (!result?.ok) {
      this.log.warn({ reason: result?.reason }, 'failed to create Apple Calendar study block');
      return null;
    }
    return result.identifier ?? null;
  }

  async deleteBlock(name: string, eventId: string): Promise<boolean> {
    const bare = eventId.startsWith('apple:') ? eventId.slice('apple:'.length) : eventId;
    const result = await this.call<{ ok: boolean }>(DELETE_EVENT_SCRIPT, {
      calendarName: name,
      eventId: bare,
    });
    return Boolean(result?.ok);
  }
}
