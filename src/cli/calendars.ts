import { stdout } from 'node:process';
import { loadEnv } from '../config/env.js';
import { getAuthorizedClient } from '../integrations/google/auth.js';
import { AppleCalendarSource, isMacOs } from '../calendar/appleCalendarSource.js';
import { GoogleCalendarSource } from '../calendar/googleCalendarSource.js';
import { IcsCalendarSource } from '../calendar/icsCalendarSource.js';
import { silentLogger } from '../utils/logger.js';

/**
 * `npm run calendars` — read-only listing of every calendar the agent can see.
 *
 * The names printed here are exactly what belongs in `APPLE_CALENDAR_NAMES` and
 * in the `calendar_id` column of the COURSES tab, which is otherwise guesswork.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const requested = new Set(env.CALENDAR_SOURCES);

  stdout.write('\n\x1b[1mCalendars visible to execution-agent\x1b[0m\n');
  stdout.write(`Configured sources: ${[...requested].join(', ') || '(none)'}\n`);

  let found = 0;

  if (requested.has('apple')) {
    stdout.write('\n\x1b[1mApple Calendar (macOS)\x1b[0m\n');
    if (!isMacOs()) {
      stdout.write('  Not available — this is not macOS.\n');
    } else {
      const apple = new AppleCalendarSource({ calendarNames: [], logger: silentLogger });
      const calendars = await apple.listCalendars();
      if (calendars.length === 0) {
        stdout.write(
          '  None visible. macOS has probably not granted Calendar access yet:\n' +
            '  System Settings > Privacy & Security > Calendars, then enable your terminal app.\n',
        );
      } else {
        for (const calendar of calendars) {
          const flag = calendar.writable ? '' : '  \x1b[90m(read-only)\x1b[0m';
          stdout.write(`  ${calendar.title}${flag}\n`);
        }
        found += calendars.length;
        const filter = env.APPLE_CALENDAR_NAMES;
        stdout.write(
          filter.length > 0
            ? `\n  Currently reading only: ${filter.join(', ')}\n`
            : '\n  Currently reading: all of them (APPLE_CALENDAR_NAMES is blank)\n',
        );
      }
    }
  }

  if (requested.has('google')) {
    stdout.write('\n\x1b[1mGoogle Calendar\x1b[0m\n');
    const auth = getAuthorizedClient(env);
    if (!auth) {
      stdout.write('  Not authorized. Run: npm run auth:google\n');
    } else {
      try {
        const google = new GoogleCalendarSource({
          auth,
          calendarIds: [],
          logger: silentLogger,
          timezone: 'UTC',
        });
        const calendars = await google.listCalendars();
        for (const calendar of calendars) {
          stdout.write(`  ${calendar.primary ? '*' : ' '} ${calendar.summary}\n      ${calendar.id}\n`);
        }
        found += calendars.length;
      } catch (error) {
        stdout.write(`  Could not list: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  if (requested.has('ics')) {
    stdout.write('\n\x1b[1mICS feeds\x1b[0m\n');
    if (env.ICS_CALENDAR_URLS.length === 0) {
      stdout.write('  None configured (ICS_CALENDAR_URLS is blank).\n');
    } else {
      const ics = new IcsCalendarSource({
        sources: env.ICS_CALENDAR_URLS,
        logger: silentLogger,
        timezone: 'UTC',
      });
      const status = await ics.healthCheck();
      for (const source of env.ICS_CALENDAR_URLS) stdout.write(`  ${source}\n`);
      stdout.write(`  ${status.detail}\n`);
      found += status.calendarsFound ?? 0;
    }
  }

  stdout.write(
    found > 0
      ? '\nPut a calendar name in the COURSES tab\'s calendar_id column to link it to a course.\n\n'
      : '\nNo calendars found. Run `npm run doctor` for the specific fix.\n\n',
  );
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to list calendars:', error instanceof Error ? error.message : error);
  process.exit(1);
});
