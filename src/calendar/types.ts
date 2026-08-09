import type { DateTime } from 'luxon';

/**
 * A normalised calendar event. Google, Apple Calendar and ICS feeds all reduce
 * to this shape so the scheduling logic never learns where an event came from.
 */
export interface CalendarEvent {
  /** Stable within a source; prefixed with the source id to stay unique overall. */
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** Human-readable calendar name, e.g. "MATH 1A" or "Work". */
  calendarName: string;
  /** Which adapter produced this. */
  source: CalendarSourceId;
  location?: string | null;
  description?: string | null;
  /** True when the user marked themselves free — such events do not block time. */
  transparent?: boolean;
}

export type CalendarSourceId = 'google' | 'apple' | 'ics';

export interface CalendarSourceStatus {
  id: CalendarSourceId;
  ok: boolean;
  detail: string;
  calendarsFound?: number;
}

/**
 * Read-only by contract. Writing is a separate, explicitly-opted-in interface
 * so that no code path can accidentally mutate the user's real calendar.
 */
export interface CalendarSource {
  readonly id: CalendarSourceId;
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
  healthCheck(): Promise<CalendarSourceStatus>;
}

export interface StudyBlockRequest {
  title: string;
  start: DateTime;
  end: DateTime;
  description?: string;
}

/**
 * Writing is confined to a dedicated calendar the agent owns. Implementations
 * must create/find that calendar by name and refuse to write anywhere else.
 */
export interface StudyBlockWriter {
  readonly id: CalendarSourceId;
  /** Creates the dedicated calendar if needed. Returns its identifier. */
  ensureCalendar(name: string): Promise<string>;
  listAgentBlocks(name: string, from: Date, to: Date): Promise<CalendarEvent[]>;
  createBlock(name: string, block: StudyBlockRequest): Promise<string | null>;
  deleteBlock(name: string, eventId: string): Promise<boolean>;
}
