import pino from 'pino';

/**
 * Keys whose values must never reach the logs. Matched case-insensitively
 * against the *key name*, anywhere in the object tree.
 */
const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|apikey|client[-_]?secret|refresh[-_]?token|access[-_]?token|authorization|cookie|private[-_]?key|credential)/i;

const REDACTED = '[redacted]';

/**
 * Values that look like secrets even when the key name is innocent
 * (e.g. a URL with `?password=hunter2`, or a bearer token pasted into a message).
 */
/**
 * Group 1, where present, is the part to KEEP (so `?password=` stays readable
 * while its value goes). Patterns whose entire match is the secret must use
 * non-capturing groups only — a capture group there would be mistaken for a
 * prefix and the secret would be re-emitted verbatim.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /([?&](?:password|guid|token|api_key|apikey)=)[^&\s]+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
  /sk-[A-Za-z0-9\-_]{12,}/gi,
  /ya29\.[A-Za-z0-9._-]{10,}/gi,
  /AIza[A-Za-z0-9\-_]{20,}/g,
];

export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (_match, keep: string | undefined) =>
      typeof keep === 'string' ? `${keep}${REDACTED}` : REDACTED,
    );
  }
  return out;
}

/**
 * Deep-redacts an arbitrary value before it is logged. Cycles are tolerated.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(val, seen);
  }
  return out;
}

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_FORMAT !== 'json' && process.env.NODE_ENV !== 'production';

const base = pino({
  level,
  // Belt-and-braces: pino's own redaction for the common shapes, plus our
  // `redact()` helper applied at every call site through the wrapper below.
  redact: {
    paths: [
      'password',
      'token',
      'apiKey',
      'api_key',
      'headers.authorization',
      'headers.cookie',
      '*.password',
      '*.token',
      '*.apiKey',
    ],
    censor: REDACTED,
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

function wrap(instance: pino.Logger): Logger {
  const call =
    (method: 'debug' | 'info' | 'warn' | 'error') =>
    (obj: unknown, msg?: string): void => {
      if (typeof obj === 'string') {
        instance[method](redactString(obj));
        return;
      }
      instance[method](redact(obj) as object, msg ? redactString(msg) : undefined);
    };

  return {
    debug: call('debug'),
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
    child: (bindings) => wrap(instance.child(redact(bindings) as Record<string, unknown>)),
  };
}

export const logger: Logger = wrap(base);

/** A logger that swallows everything — used by tests and simulation. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
