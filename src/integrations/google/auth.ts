import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { resolvePath, type Env } from '../../config/env.js';
import type { Logger } from '../../utils/logger.js';

/**
 * Read/write on Sheets (the agent updates task status) and read/write on
 * Calendar — but the Calendar *client* refuses to touch anything except its own
 * `Execution Agent` calendar. The scope is broad because Google offers no
 * single-calendar scope; the safety guarantee is enforced in code.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',
];

export interface StoredToken {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

export function tokenPathFor(env: Env): string {
  return resolvePath(env.GOOGLE_TOKEN_PATH);
}

export function readStoredToken(env: Env): StoredToken | null {
  const file = tokenPathFor(env);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredToken;
  } catch {
    return null;
  }
}

function writeStoredToken(env: Env, token: StoredToken): void {
  const file = tokenPathFor(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(token, null, 2), { mode: 0o600 });
}

export function createOAuthClient(env: Env): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. See SETUP.md step 5.',
    );
  }
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

/**
 * Returns an authorised client, or null when the user has not completed
 * `npm run auth:google` yet. Callers degrade gracefully rather than crashing —
 * the agent should still be able to report *why* it cannot reach Google.
 */
export function getAuthorizedClient(env: Env): OAuth2Client | null {
  const token = readStoredToken(env);
  if (!token?.refresh_token && !token?.access_token) return null;

  const client = createOAuthClient(env);
  client.setCredentials(token);
  // Persist refreshed access tokens so the next start does not need a round trip.
  client.on('tokens', (fresh) => {
    const merged = { ...readStoredToken(env), ...fresh } as StoredToken;
    writeStoredToken(env, merged);
  });
  return client;
}

export function authUrl(client: OAuth2Client): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
  });
}

/**
 * Runs the one-time consent flow: prints a URL, spins a throwaway localhost
 * listener on the redirect port, exchanges the code, writes the token file.
 */
export async function runOAuthFlow(env: Env, logger: Logger): Promise<void> {
  const client = createOAuthClient(env);
  const redirect = new URL(env.GOOGLE_REDIRECT_URI);
  const port = Number(redirect.port || 80);

  const url = authUrl(client);
  process.stdout.write(
    `\nOpen this URL in your browser and approve access:\n\n${url}\n\nWaiting for Google to redirect back...\n`,
  );

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
        if (requestUrl.pathname !== redirect.pathname) {
          res.writeHead(404).end('Not found');
          return;
        }
        const error = requestUrl.searchParams.get('error');
        if (error) {
          res.writeHead(400).end(`Authorization failed: ${error}`);
          server.close();
          reject(new Error(`Google returned an error: ${error}`));
          return;
        }
        const receivedCode = requestUrl.searchParams.get('code');
        if (!receivedCode) {
          res.writeHead(400).end('Missing authorization code');
          return;
        }
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            '<html><body style="font-family:system-ui;padding:40px"><h2>Authorized.</h2><p>You can close this tab and return to the terminal.</p></body></html>',
          );
        server.close();
        resolve(receivedCode);
      } catch (err) {
        server.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
    // A browser tab left open forever should not hang the CLI.
    setTimeout(
      () => {
        server.close();
        reject(new Error('Timed out waiting for Google authorization (5 minutes).'));
      },
      5 * 60_000,
    ).unref();
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    logger.warn(
      {},
      'Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and re-run so it issues one.',
    );
  }
  writeStoredToken(env, tokens as StoredToken);
  process.stdout.write(`\nSaved credentials to ${tokenPathFor(env)}\n`);
}
