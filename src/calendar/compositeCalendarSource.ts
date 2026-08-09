import type { Logger } from '../utils/logger.js';
import type { CalendarEvent, CalendarSource, CalendarSourceStatus } from './types.js';

/**
 * Merges several calendar backends into one view.
 *
 * The user's Google account and their Mac's Calendar.app frequently contain the
 * SAME events (a Google account added to macOS appears in both). Showing a
 * class twice would make the day look twice as full and wrongly trip
 * overload-based rescue, so near-identical events are collapsed.
 */
export class CompositeCalendarSource implements CalendarSource {
  /** Reported as `google` for interface purposes; `sources` holds the real list. */
  readonly id = 'google' as const;

  constructor(
    private readonly sources: CalendarSource[],
    private readonly log: Logger,
  ) {}

  get backends(): CalendarSource[] {
    return this.sources;
  }

  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const results = await Promise.all(
      this.sources.map(async (source) => {
        try {
          return await source.listEvents(from, to);
        } catch (error) {
          this.log.warn(
            { source: source.id, error: error instanceof Error ? error.message : String(error) },
            'calendar source failed; continuing with the others',
          );
          return [] as CalendarEvent[];
        }
      }),
    );
    return dedupeEvents(results.flat());
  }

  async healthCheck(): Promise<CalendarSourceStatus> {
    const statuses = await Promise.all(this.sources.map((s) => s.healthCheck()));
    const healthy = statuses.filter((s) => s.ok);
    return {
      id: this.id,
      ok: healthy.length > 0,
      detail: statuses.map((s) => `${s.id}: ${s.ok ? 'ok' : s.detail}`).join(' | '),
      calendarsFound: statuses.reduce((sum, s) => sum + (s.calendarsFound ?? 0), 0),
    };
  }

  async healthCheckAll(): Promise<CalendarSourceStatus[]> {
    return Promise.all(this.sources.map((s) => s.healthCheck()));
  }
}

/** Two events are "the same" if title and start/end match within a minute. */
function dedupeKey(event: CalendarEvent): string {
  const round = (date: Date): number => Math.round(date.getTime() / 60_000);
  return `${event.title.trim().toLowerCase()}|${round(event.start)}|${round(event.end)}`;
}

export function dedupeEvents(events: CalendarEvent[]): CalendarEvent[] {
  // Google wins ties over Apple, and Apple over ICS, purely so the retained id
  // is stable across runs rather than dependent on network timing.
  const rank: Record<string, number> = { google: 0, apple: 1, ics: 2 };
  const sorted = [...events].sort(
    (a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9),
  );

  const seen = new Map<string, CalendarEvent>();
  for (const event of sorted) {
    const key = dedupeKey(event);
    if (!seen.has(key)) seen.set(key, event);
  }
  return [...seen.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** A CalendarSource backed by a fixed list — used by tests and simulation. */
export class StaticCalendarSource implements CalendarSource {
  readonly id = 'google' as const;

  constructor(private readonly events: CalendarEvent[]) {}

  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    return this.events
      .filter((event) => event.end > from && event.start < to)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async healthCheck(): Promise<CalendarSourceStatus> {
    return { id: this.id, ok: true, detail: 'static test calendar', calendarsFound: 1 };
  }
}
