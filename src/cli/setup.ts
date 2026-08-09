import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { PROJECT_ROOT, loadEnv, resolvePath } from '../config/env.js';
import { getAuthorizedClient, readStoredToken, runOAuthFlow } from '../integrations/google/auth.js';
import { GoogleSheetsRepository } from '../sheets/googleSheetsRepository.js';
import { GoogleCalendarSource } from '../calendar/googleCalendarSource.js';
import { AppleCalendarSource, isMacOs } from '../calendar/appleCalendarSource.js';
import { BlueBubblesClient } from '../integrations/bluebubbles/client.js';
import { logger, silentLogger } from '../utils/logger.js';
import { seedCourses, seedMastery, seedTasks } from './seedData.js';
import { DateTime } from 'luxon';

/**
 * `npm run setup` — interactive, resumable, and safe to re-run.
 *
 * It never overwrites a value that is already working. Anything that cannot be
 * automated (creating OAuth credentials, installing BlueBubbles) is printed as
 * an explicit MANUAL STEP pointing at SETUP.md.
 */

const ENV_PATH = path.join(PROJECT_ROOT, '.env');

function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Rewrites .env in place, preserving comments and key order. */
function writeEnvValues(updates: Record<string, string>): void {
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const remaining = new Map(Object.entries(updates));
  const lines = existing.map((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      const value = remaining.get(key) as string;
      remaining.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

function heading(text: string): void {
  stdout.write(`\n\x1b[1m${text}\x1b[0m\n${'─'.repeat(Math.min(70, text.length + 2))}\n`);
}

function manual(text: string): void {
  stdout.write(`\x1b[33mMANUAL STEP\x1b[0m  ${text}\n`);
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (question: string, fallback = ''): Promise<string> => {
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer === '' ? fallback : answer;
  };

  try {
    stdout.write('\n\x1b[1mexecution-agent setup\x1b[0m\n');
    stdout.write('Safe to re-run. Press Enter to keep any value shown in brackets.\n');

    // ---- 1. .env exists -------------------------------------------------
    heading('1. Configuration file');
    if (!fs.existsSync(ENV_PATH)) {
      const example = path.join(PROJECT_ROOT, '.env.example');
      if (fs.existsSync(example)) {
        fs.copyFileSync(example, ENV_PATH);
        fs.chmodSync(ENV_PATH, 0o600);
        stdout.write('Created .env from .env.example.\n');
      } else {
        fs.writeFileSync(ENV_PATH, '', { mode: 0o600 });
        stdout.write('Created an empty .env.\n');
      }
    } else {
      stdout.write('.env already exists — keeping it.\n');
    }
    const current = readEnvFile();

    // ---- 2. Google OAuth credentials ------------------------------------
    heading('2. Google credentials');
    if (!current['GOOGLE_CLIENT_ID'] || !current['GOOGLE_CLIENT_SECRET']) {
      manual('Create an OAuth client ID (Desktop app) — SETUP.md step 5 has the exact clicks.');
      const clientId = await ask('Google Client ID', current['GOOGLE_CLIENT_ID'] ?? '');
      const clientSecret = await ask('Google Client Secret', current['GOOGLE_CLIENT_SECRET'] ?? '');
      if (clientId && clientSecret) {
        writeEnvValues({ GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret });
        stdout.write('Saved Google credentials to .env.\n');
      } else {
        stdout.write('Skipped — re-run setup once you have them.\n');
      }
    } else {
      stdout.write('Google client credentials already configured.\n');
    }

    // Re-read so the OAuth step sees anything just written.
    let env = loadEnv({ ...process.env, ...readEnvFile() });

    // ---- 3. Authorize Google --------------------------------------------
    heading('3. Authorize Google (Sheets + Calendar)');
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
      if (readStoredToken(env)) {
        stdout.write('Already authorized. Delete the token file to redo this.\n');
      } else {
        const go = await ask('Open the Google consent screen now? (y/n)', 'y');
        if (go.toLowerCase().startsWith('y')) {
          await runOAuthFlow(env, logger);
        } else {
          stdout.write('Skipped — run `npm run auth:google` later.\n');
        }
      }
    } else {
      stdout.write('Skipped — Google credentials are not set yet.\n');
    }

    env = loadEnv({ ...process.env, ...readEnvFile() });
    const auth = getAuthorizedClient(env);

    // ---- 4. Spreadsheet --------------------------------------------------
    heading('4. Google Sheet');
    let spreadsheetId = env.SPREADSHEET_ID ?? '';
    if (auth) {
      if (!spreadsheetId) {
        const create = await ask('Create a new spreadsheet automatically? (y/n)', 'y');
        if (create.toLowerCase().startsWith('y')) {
          const sheetsApi = google.sheets({ version: 'v4', auth });
          const created = await sheetsApi.spreadsheets.create({
            requestBody: { properties: { title: 'Execution Agent' } },
          });
          spreadsheetId = created.data.spreadsheetId ?? '';
          if (spreadsheetId) {
            writeEnvValues({ SPREADSHEET_ID: spreadsheetId });
            stdout.write(`Created: https://docs.google.com/spreadsheets/d/${spreadsheetId}\n`);
          }
        } else {
          manual('Create a blank Google Sheet and copy its ID from the URL.');
          spreadsheetId = await ask('Spreadsheet ID');
          if (spreadsheetId) writeEnvValues({ SPREADSHEET_ID: spreadsheetId });
        }
      } else {
        stdout.write(`Using existing spreadsheet ${spreadsheetId}.\n`);
      }

      if (spreadsheetId) {
        const repository = new GoogleSheetsRepository({ auth, spreadsheetId, logger: silentLogger });
        await repository.ensureStructure();
        stdout.write('Tabs and headers are in place (CONFIG defaults seeded).\n');

        const existingTasks = await repository.listTasks();
        if (existingTasks.length === 0) {
          const seed = await ask('Add demo tasks and courses so you can see it work? (y/n)', 'y');
          if (seed.toLowerCase().startsWith('y')) {
            const now = DateTime.now().setZone('America/Los_Angeles');
            for (const course of seedCourses()) await repository.upsertCourse(course);
            for (const task of seedTasks(now)) await repository.createTask(task);
            for (const row of seedMastery()) await repository.upsertMastery(row);
            stdout.write('Demo data added. Delete those rows any time.\n');
          }
        } else {
          stdout.write(`Spreadsheet already has ${existingTasks.length} task rows — not seeding.\n`);
        }
      }
    } else {
      stdout.write('Skipped — Google is not authorized yet.\n');
    }

    // ---- 5. Calendars -----------------------------------------------------
    heading('5. Calendars');
    stdout.write('Sources: google, apple (macOS Calendar.app), ics (feed URL or file).\n');
    stdout.write('Apple Calendar covers iCloud, Exchange, and any account added to your Mac.\n');
    const defaultSources = current['CALENDAR_SOURCES'] ?? (isMacOs() ? 'google,apple' : 'google');
    const sources = await ask('Which calendar sources? (comma separated)', defaultSources);
    writeEnvValues({ CALENDAR_SOURCES: sources });

    if (sources.includes('google') && auth) {
      const calendarSource = new GoogleCalendarSource({
        auth,
        calendarIds: [],
        logger: silentLogger,
        timezone: 'America/Los_Angeles',
      });
      try {
        const calendars = await calendarSource.listCalendars();
        stdout.write('\nYour Google calendars:\n');
        for (const cal of calendars) {
          stdout.write(`  ${cal.primary ? '*' : ' '} ${cal.summary}\n      ${cal.id}\n`);
        }
        const chosen = await ask(
          'Google calendar IDs to read (blank = primary only)',
          current['GOOGLE_CALENDAR_IDS'] ?? '',
        );
        writeEnvValues({ GOOGLE_CALENDAR_IDS: chosen });
      } catch (error) {
        stdout.write(`Could not list Google calendars: ${error instanceof Error ? error.message : error}\n`);
      }
    }

    if (sources.includes('apple')) {
      if (isMacOs()) {
        stdout.write('\nChecking Apple Calendar access (macOS may show a permission prompt)...\n');
        const apple = new AppleCalendarSource({ calendarNames: [], logger: silentLogger });
        const calendars = await apple.listCalendars();
        if (calendars.length === 0) {
          manual(
            'Grant Calendar access: System Settings > Privacy & Security > Calendars, then enable the terminal app you are using.',
          );
        } else {
          stdout.write('Your Apple calendars:\n');
          for (const cal of calendars) {
            stdout.write(`  ${cal.writable ? ' ' : '(read-only) '}${cal.title}\n`);
          }
          const names = await ask(
            'Apple calendar names to read (blank = all)',
            current['APPLE_CALENDAR_NAMES'] ?? '',
          );
          writeEnvValues({ APPLE_CALENDAR_NAMES: names });
        }
      } else {
        stdout.write('Apple Calendar needs macOS — skipping on this platform.\n');
      }
    }

    if (sources.includes('ics')) {
      manual('Paste any .ics feed URLs (Canvas export, published iCloud calendar), comma separated.');
      const urls = await ask('ICS URLs', current['ICS_CALENDAR_URLS'] ?? '');
      writeEnvValues({ ICS_CALENDAR_URLS: urls });
    }

    // ---- 6. BlueBubbles ---------------------------------------------------
    heading('6. BlueBubbles (iMessage bridge)');
    manual('Install and start the BlueBubbles Server on this Mac first — SETUP.md steps 2–4.');
    stdout.write('Keep System Integrity Protection ON. This project does not need the Private API.\n');
    const serverUrl = await ask('BlueBubbles server URL', current['BLUEBUBBLES_SERVER_URL'] ?? 'http://localhost:1234');
    const password = await ask('BlueBubbles password', current['BLUEBUBBLES_PASSWORD'] ?? '');
    if (serverUrl && password) {
      writeEnvValues({ BLUEBUBBLES_SERVER_URL: serverUrl, BLUEBUBBLES_PASSWORD: password });
      const client = new BlueBubblesClient({ serverUrl, password, logger: silentLogger });
      const health = await client.healthCheck();
      stdout.write(health.ok ? '✓ BlueBubbles is reachable.\n' : `✗ ${health.detail}\n`);
    }

    // ---- 7. iMessage identity ---------------------------------------------
    heading('7. iMessage identity');
    stdout.write(
      'AUTHORIZED_USER_HANDLE = the address you text FROM.\nTARGET_HANDLE = the address the agent sends TO.\n',
    );
    const authorized = await ask(
      'Your handle (phone or Apple ID email)',
      current['AUTHORIZED_USER_HANDLE'] ?? '',
    );
    const target = await ask('Send messages to', current['TARGET_HANDLE'] ?? authorized);
    if (authorized) writeEnvValues({ AUTHORIZED_USER_HANDLE: authorized });
    if (target) writeEnvValues({ TARGET_HANDLE: target });

    if (authorized && target && authorized.toLowerCase() === target.toLowerCase()) {
      stdout.write(
        '\n\x1b[33mHeads up:\x1b[0m those are the same address.\n' +
          'If the BlueBubbles Mac is signed into that same Apple ID, your own messages arrive\n' +
          'marked isFromMe — indistinguishable from the agent\'s own output — so they will be\n' +
          'ignored to prevent a reply loop. See the "iMessage identity" section of SETUP.md;\n' +
          'a clean setup usually needs a second iMessage-capable address for the bridge.\n',
      );
    }

    // ---- 8. Webhook secret -------------------------------------------------
    heading('8. Webhook');
    let secret = current['WEBHOOK_SECRET'] ?? '';
    if (!secret) {
      secret = (await import('node:crypto')).randomUUID().replace(/-/g, '');
      writeEnvValues({ WEBHOOK_SECRET: secret });
      stdout.write('Generated a webhook secret.\n');
    }
    const port = current['PORT'] ?? '4711';
    manual(
      `In the BlueBubbles Server app open API & Webhooks > Webhooks > Add, and paste:\n              http://localhost:${port}/webhook/bluebubbles?secret=${secret}\n              Subscribe it to the "New Messages" event.`,
    );

    // ---- done --------------------------------------------------------------
    heading('Done');
    fs.mkdirSync(resolvePath(readEnvFile()['DATA_DIR'] ?? './data'), { recursive: true });
    stdout.write('Next:\n  1. npm run doctor\n  2. npm run send:test\n  3. npm run dev\n\n');
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('\nSetup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
