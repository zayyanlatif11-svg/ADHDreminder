import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..', '..');

loadDotenv({ path: path.join(PROJECT_ROOT, '.env') });

const booleanish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    if (v === undefined || v === '') return undefined;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  });

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),

  /** Local HTTP port the BlueBubbles webhook posts to. */
  PORT: z.coerce.number().int().min(1).max(65535).default(4711),
  HOST: z.string().default('127.0.0.1'),

  // ---- BlueBubbles -------------------------------------------------------
  BLUEBUBBLES_SERVER_URL: z.string().optional(),
  BLUEBUBBLES_PASSWORD: z.string().optional(),
  /**
   * `apple-script` works with SIP enabled and no Private API.
   * `private-api` is NOT required by this project and is only honoured if you
   * have separately enabled it. Default stays on the SIP-safe path.
   */
  BLUEBUBBLES_SEND_METHOD: z.enum(['apple-script', 'private-api']).default('apple-script'),
  /** Shared secret appended to the webhook URL so random localhost callers are rejected. */
  WEBHOOK_SECRET: z.string().optional(),

  // ---- iMessage identity -------------------------------------------------
  /** The handle whose inbound messages the agent will obey. Everything else is ignored. */
  AUTHORIZED_USER_HANDLE: z.string().optional(),
  /** Where the agent sends messages. Usually the same as AUTHORIZED_USER_HANDLE. */
  TARGET_HANDLE: z.string().optional(),
  /** Optional explicit chat GUID; if absent it is resolved from TARGET_HANDLE. */
  CHAT_GUID: z.string().optional(),
  /** Extra handles permitted to command the agent (rare; e.g. a second device address). */
  ADDITIONAL_AUTHORIZED_HANDLES: csv,

  // ---- Google ------------------------------------------------------------
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:4712/oauth2callback'),
  GOOGLE_TOKEN_PATH: z.string().default('./secrets/google-token.json'),
  SPREADSHEET_ID: z.string().optional(),

  // ---- Calendar sources --------------------------------------------------
  /** Comma-separated list: google, apple, ics. Order does not matter; results are merged. */
  CALENDAR_SOURCES: z
    .string()
    .default('google')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Google calendar IDs to read. Empty means "primary". */
  GOOGLE_CALENDAR_IDS: csv,
  /** Apple Calendar (macOS Calendar.app) calendar names to read. Empty means all. */
  APPLE_CALENDAR_NAMES: csv,
  /** ICS URLs or local .ics paths (e.g. a Canvas feed, or a published iCloud calendar). */
  ICS_CALENDAR_URLS: csv,

  /** Calendar the agent may WRITE generated study blocks to. Never the user's main calendar. */
  STUDY_BLOCK_CALENDAR_NAME: z.string().default('Execution Agent'),
  /** Which backend receives generated study blocks. */
  STUDY_BLOCK_TARGET: z.enum(['google', 'apple', 'none']).default('none'),

  // ---- Optional LLM ------------------------------------------------------
  /** Entirely optional. Every core feature works with this unset. */
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.enum(['none', 'anthropic']).default('none'),
  LLM_MODEL: z.string().default('claude-sonnet-5'),

  // ---- Local state -------------------------------------------------------
  DATA_DIR: z.string().default('./data'),
  /** Master switch for outbound sends. `true` = never actually send (simulation). */
  DRY_RUN: booleanish,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(overrides: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(overrides);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper — forget the memoised env so a new process.env can be read. */
export function resetEnvCache(): void {
  cached = null;
}

export function resolvePath(maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(PROJECT_ROOT, maybeRelative);
}
