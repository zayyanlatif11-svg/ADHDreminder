import { stdout } from 'node:process';
import { DateTime } from 'luxon';
import { authorizedHandles, buildApp } from '../app.js';
import { env as loadEnvironment, resolvePath } from '../config/env.js';
import { readStoredToken, tokenPathFor } from '../integrations/google/auth.js';
import { CompositeCalendarSource } from '../calendar/compositeCalendarSource.js';
import { isMacOs } from '../calendar/appleCalendarSource.js';
import { normalizeHandle } from '../integrations/bluebubbles/types.js';
import { silentLogger } from '../utils/logger.js';
import { isWithinQuietHours } from '../utils/time.js';

/**
 * `npm run doctor` — one command that answers "is this thing actually set up?"
 * Every check reports its own fix, so the user never has to guess what to do.
 */

type Status = 'ok' | 'warn' | 'fail' | 'skip';

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const ICON: Record<Status, string> = {
  ok: '\x1b[32m✓\x1b[0m',
  warn: '\x1b[33m!\x1b[0m',
  fail: '\x1b[31m✗\x1b[0m',
  skip: '\x1b[90m–\x1b[0m',
};

function print(result: CheckResult): void {
  stdout.write(`${ICON[result.status]} ${result.name}\n    ${result.detail}\n`);
  if (result.fix) stdout.write(`    \x1b[36mFix:\x1b[0m ${result.fix}\n`);
}

async function main(): Promise<void> {
  stdout.write('\n\x1b[1mexecution-agent doctor\x1b[0m\n\n');
  const results: CheckResult[] = [];

  // ---- environment ------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  results.push({
    name: 'Node.js version',
    status: major >= 20 ? 'ok' : 'fail',
    detail: `Node ${process.versions.node}`,
    ...(major >= 20 ? {} : { fix: 'Install Node 20 or newer — see SETUP.md step 1.' }),
  });

  let env;
  try {
    env = loadEnvironment();
    results.push({ name: 'Environment file', status: 'ok', detail: '.env parsed successfully' });
  } catch (error) {
    results.push({
      name: 'Environment file',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      fix: 'Copy .env.example to .env and fill it in.',
    });
    results.forEach(print);
    process.exit(1);
  }

  // ---- Google credentials ----------------------------------------------
  const hasClient = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  results.push({
    name: 'Google OAuth client',
    status: hasClient ? 'ok' : 'fail',
    detail: hasClient ? 'Client ID and secret are present' : 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing',
    ...(hasClient ? {} : { fix: 'SETUP.md step 5 walks through creating these in Google Cloud Console.' }),
  });

  const token = readStoredToken(env);
  results.push({
    name: 'Google authorization',
    status: token ? 'ok' : 'fail',
    detail: token
      ? `Token found at ${tokenPathFor(env)}`
      : 'No saved Google token',
    ...(token ? {} : { fix: 'Run: npm run auth:google' }),
  });

  const app = await buildApp({ logger: silentLogger });

  try {
    // ---- Sheets ---------------------------------------------------------
    if (env.SPREADSHEET_ID && token) {
      try {
        const config = await app.repository.getConfig();
        const tasks = await app.repository.listTasks();
        results.push({
          name: 'Google Sheets access',
          status: 'ok',
          detail: `Spreadsheet reachable — ${Object.keys(config).length} config keys, ${tasks.length} task rows`,
        });
      } catch (error) {
        results.push({
          name: 'Google Sheets access',
          status: 'fail',
          detail: error instanceof Error ? error.message : String(error),
          fix: 'Check SPREADSHEET_ID in .env, then run: npm run setup',
        });
      }
    } else {
      results.push({
        name: 'Google Sheets access',
        status: 'fail',
        detail: env.SPREADSHEET_ID ? 'Not authorized yet' : 'SPREADSHEET_ID is not set',
        fix: 'SETUP.md step 8, then: npm run setup',
      });
    }

    // ---- Calendars ------------------------------------------------------
    const calendar = app.calendar;
    if (calendar instanceof CompositeCalendarSource) {
      const statuses = await calendar.healthCheckAll();
      if (statuses.length === 0) {
        results.push({
          name: 'Calendar sources',
          status: 'warn',
          detail: 'No calendar sources configured',
          fix: 'Set CALENDAR_SOURCES in .env (google, apple, ics — comma separated).',
        });
      }
      for (const status of statuses) {
        results.push({
          name: `Calendar: ${status.id}`,
          status: status.ok ? 'ok' : 'warn',
          detail: status.ok
            ? `${status.detail} (${status.calendarsFound ?? 0} calendars)`
            : status.detail,
          ...(status.ok
            ? {}
            : {
                fix:
                  status.id === 'apple'
                    ? 'Approve Calendar access: System Settings > Privacy & Security > Calendars.'
                    : status.id === 'google'
                      ? 'Run: npm run auth:google'
                      : 'Check ICS_CALENDAR_URLS in .env.',
              }),
        });
      }
    }

    if (env.CALENDAR_SOURCES.includes('apple') && !isMacOs()) {
      results.push({
        name: 'Apple Calendar platform',
        status: 'warn',
        detail: 'Apple Calendar was requested but this machine is not macOS',
        fix: 'Remove "apple" from CALENDAR_SOURCES, or run the agent on the Mac.',
      });
    }

    // ---- BlueBubbles ----------------------------------------------------
    if (env.BLUEBUBBLES_SERVER_URL && env.BLUEBUBBLES_PASSWORD) {
      const health = await app.adapter.healthCheck();
      results.push({
        name: 'BlueBubbles server',
        status: health.ok ? 'ok' : 'fail',
        detail: health.ok
          ? `${health.detail}${health.serverVersion ? ` (${health.serverVersion})` : ''}`
          : health.detail,
        ...(health.ok
          ? {}
          : { fix: 'Confirm the BlueBubbles server is running and the URL/password are right (SETUP.md step 4).' }),
      });
    } else {
      results.push({
        name: 'BlueBubbles server',
        status: 'fail',
        detail: 'BLUEBUBBLES_SERVER_URL / BLUEBUBBLES_PASSWORD not set',
        fix: 'SETUP.md steps 2–4.',
      });
    }

    // ---- iMessage identity ----------------------------------------------
    const handles = authorizedHandles(env);
    results.push({
      name: 'Authorized sender',
      status: handles.length > 0 ? 'ok' : 'fail',
      detail:
        handles.length > 0
          ? `Will accept commands from: ${handles.map(normalizeHandle).join(', ')}`
          : 'AUTHORIZED_USER_HANDLE is not set — all inbound messages will be ignored',
      ...(handles.length > 0 ? {} : { fix: 'Set AUTHORIZED_USER_HANDLE in .env to your phone number or Apple ID email.' }),
    });

    const destination = env.CHAT_GUID ?? env.TARGET_HANDLE;
    results.push({
      name: 'Message destination',
      status: destination ? 'ok' : 'fail',
      detail: destination ? `Sending to ${env.CHAT_GUID ? 'chat GUID' : normalizeHandle(env.TARGET_HANDLE)}` : 'No TARGET_HANDLE or CHAT_GUID',
      ...(destination ? {} : { fix: 'Set TARGET_HANDLE in .env.' }),
    });

    // The self-messaging trap: same handle both ways means the agent cannot
    // distinguish the user's commands from its own output.
    if (
      env.AUTHORIZED_USER_HANDLE &&
      env.TARGET_HANDLE &&
      normalizeHandle(env.AUTHORIZED_USER_HANDLE) === normalizeHandle(env.TARGET_HANDLE)
    ) {
      results.push({
        name: 'iMessage identity',
        status: 'warn',
        detail:
          'AUTHORIZED_USER_HANDLE and TARGET_HANDLE are the same. If the BlueBubbles Mac is signed into that same Apple ID, your own commands arrive flagged isFromMe and will be ignored along with the bot output.',
        fix: 'See SETUP.md "iMessage identity" — this usually needs a second iMessage-capable address for the bridge.',
      });
    } else if (env.AUTHORIZED_USER_HANDLE && env.TARGET_HANDLE) {
      results.push({
        name: 'iMessage identity',
        status: 'ok',
        detail: 'Sender and destination handles are distinct — no self-message ambiguity',
      });
    }

    // ---- Runtime config + scheduler --------------------------------------
    const config = await app.agent.loadConfig();
    const now = DateTime.now().setZone(config.timezone);
    const quiet = isWithinQuietHours(now, config.quiet_hours_start, config.quiet_hours_end);

    results.push({
      name: 'Runtime configuration',
      status: 'ok',
      detail: `tz=${config.timezone} morning=${config.morning_time} quiet=${config.quiet_hours_start}-${config.quiet_hours_end} top=${config.top_task_count}`,
    });
    results.push({
      name: 'Quiet hours (now)',
      status: 'ok',
      detail: quiet
        ? `It is ${now.toFormat('h:mm a')} — inside quiet hours. Proactive messages are paused; your commands still work.`
        : `It is ${now.toFormat('h:mm a')} — outside quiet hours.`,
    });

    const morningSent = app.state.hasSentToday('morning', now.toFormat('yyyy-LL-dd'));
    results.push({
      name: 'Scheduler state',
      status: 'ok',
      detail: morningSent
        ? "Today's morning message has already been sent (it will not repeat)."
        : "Today's morning message has not been sent yet.",
    });

    // ---- LLM ------------------------------------------------------------
    results.push({
      name: 'LLM layer (optional)',
      status: app.ai.enabled ? 'ok' : 'skip',
      detail: app.ai.enabled
        ? `Enabled: ${app.ai.name}`
        : 'Disabled. Every feature works without it — no API key required.',
    });

    // ---- Local state ------------------------------------------------------
    results.push({
      name: 'Local database',
      status: 'ok',
      detail: `SQLite ready at ${resolvePath(env.DATA_DIR)}/agent.sqlite (operational state only)`,
    });

    for (const warning of app.warnings) {
      results.push({ name: 'Configuration warning', status: 'warn', detail: warning });
    }

    results.forEach(print);

    const failures = results.filter((r) => r.status === 'fail').length;
    const warnings = results.filter((r) => r.status === 'warn').length;

    stdout.write(
      `\n${failures === 0 ? '\x1b[32mNo blocking problems.\x1b[0m' : `\x1b[31m${failures} blocking problem(s).\x1b[0m`}` +
        `${warnings > 0 ? ` ${warnings} warning(s).` : ''}\n`,
    );
    stdout.write(
      failures === 0
        ? 'Next: npm run send:test\n\n'
        : 'Work through the fixes above, then run npm run doctor again.\n\n',
    );
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    app.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('doctor failed:', error);
  process.exit(1);
});
