import { describe, expect, it, beforeEach } from 'vitest';
import { DateTime } from 'luxon';
import { webhookBody } from './helpers.js';
import { parseBlueBubblesWebhook } from '../src/integrations/bluebubbles/webhook.js';
import { authorizeInbound } from '../src/messaging/authorization.js';
import { handlesMatch, normalizeHandle } from '../src/integrations/bluebubbles/types.js';
import { openMemoryDb, type Db } from '../src/state/db.js';
import { StateStore } from '../src/state/stateStore.js';
import { Messenger } from '../src/messaging/outbound.js';
import { FakeMessagingAdapter } from '../src/integrations/bluebubbles/fakeAdapter.js';
import { parseRuntimeConfig } from '../src/config/runtimeConfig.js';
import { silentLogger, redact, redactString } from '../src/utils/logger.js';
import { isWithinQuietHours } from '../src/utils/time.js';

const ZONE = 'America/Los_Angeles';
const OWNER = '+15551234567';

function parsed(body: unknown) {
  const message = parseBlueBubblesWebhook(body);
  if (!message) throw new Error('expected the webhook to parse');
  return message;
}

describe('handle normalisation', () => {
  it('treats formatted and bare phone numbers as the same person', () => {
    expect(handlesMatch('+1 (555) 123-4567', '+15551234567')).toBe(true);
    expect(handlesMatch('5551234567', '+15551234567')).toBe(true);
  });

  it('is case-insensitive for email handles', () => {
    expect(handlesMatch('Zayyan@Example.com', 'zayyan@example.com')).toBe(true);
  });

  it('does not match different people', () => {
    expect(handlesMatch('+15551234567', '+15559999999')).toBe(false);
    expect(handlesMatch('', '+15551234567')).toBe(false);
    expect(handlesMatch(null, null)).toBe(false);
  });
});

describe('inbound authorization', () => {
  const policy = { authorizedHandles: [OWNER] };

  it('accepts a command from the authorized handle', () => {
    expect(authorizeInbound(parsed(webhookBody()), policy).allowed).toBe(true);
  });

  it('ignores messages from any other handle', () => {
    const stranger = parsed(webhookBody({ handle: '+15559999999' }));
    const result = authorizeInbound(stranger, policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unauthorized_handle');
  });

  it('ignores the bot\'s own outgoing messages so it cannot reply to itself', () => {
    const ownMessage = parsed(webhookBody({ isFromMe: true, text: 'SATURDAY — TOP 3' }));
    const result = authorizeInbound(ownMessage, policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('from_bot');
  });

  it('rejects an outgoing message even when it comes from the authorized handle', () => {
    // This is the loop-prevention invariant: isFromMe wins over the allowlist.
    const loop = parsed(webhookBody({ isFromMe: true, handle: OWNER }));
    expect(authorizeInbound(loop, policy).allowed).toBe(false);
  });

  it('rejects messages arriving in a different chat when a chat is pinned', () => {
    const otherChat = parsed(webhookBody({ chatGuid: 'iMessage;-;+15550000000' }));
    const result = authorizeInbound(otherChat, {
      ...policy,
      chatGuid: 'iMessage;-;+15551234567',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('wrong_chat');
  });

  it('rejects empty messages', () => {
    const empty = parsed(webhookBody({ text: '   ' }));
    expect(authorizeInbound(empty, policy).reason).toBe('empty_text');
  });
});

describe('webhook parsing is defensive', () => {
  it('returns null rather than throwing on junk input', () => {
    expect(parseBlueBubblesWebhook(null)).toBeNull();
    expect(parseBlueBubblesWebhook('a string')).toBeNull();
    expect(parseBlueBubblesWebhook(42)).toBeNull();
    expect(parseBlueBubblesWebhook([])).toBeNull();
    expect(parseBlueBubblesWebhook({})).toBeNull();
    expect(parseBlueBubblesWebhook({ type: 'new-message' })).toBeNull();
    expect(parseBlueBubblesWebhook({ type: 'new-message', data: {} })).toBeNull();
  });

  it('ignores non-message events like typing indicators', () => {
    expect(parseBlueBubblesWebhook({ type: 'typing-indicator', data: { guid: 'x' } })).toBeNull();
    expect(parseBlueBubblesWebhook({ type: 'chat-read-status-changed', data: { guid: 'x' } })).toBeNull();
  });

  it('accepts a bare message object with no envelope', () => {
    const message = parseBlueBubblesWebhook({
      guid: 'bare-1',
      text: 'HELP',
      isFromMe: false,
      handle: { address: OWNER },
    });
    expect(message?.messageId).toBe('bare-1');
    expect(message?.text).toBe('HELP');
  });

  it('reads text out of attributedBody when the plain field is absent', () => {
    const message = parseBlueBubblesWebhook({
      type: 'new-message',
      data: {
        guid: 'attr-1',
        attributedBody: [{ string: 'WHAT' }, { string: 'NOW' }],
        handle: { address: OWNER },
      },
    });
    expect(message?.text).toBe('WHAT NOW');
  });

  it('strips iMessage attachment placeholders that would break matching', () => {
    const message = parseBlueBubblesWebhook({
      guid: 'ph-1',
      text: '￼ DONE ￼',
      handle: { address: OWNER },
    });
    expect(message?.text).toBe('DONE');
  });

  it('caps overly long inbound text', () => {
    const message = parseBlueBubblesWebhook({
      guid: 'long-1',
      text: 'x'.repeat(50_000),
      handle: { address: OWNER },
    });
    expect(message!.text.length).toBeLessThanOrEqual(2000);
  });

  it('falls back to a chat participant when no handle is given', () => {
    const message = parseBlueBubblesWebhook({
      guid: 'p-1',
      text: 'TODAY',
      chats: [{ guid: 'c1', participants: [{ address: OWNER }] }],
    });
    expect(message?.handle).toBe(OWNER);
    expect(message?.chatGuid).toBe('c1');
  });
});

describe('webhook idempotency', () => {
  let db: Db;
  let state: StateStore;

  beforeEach(() => {
    db = openMemoryDb();
    state = new StateStore(db);
  });

  it('processes a message once and ignores every redelivery', () => {
    expect(state.markEventProcessed('msg-1')).toBe(true);
    expect(state.markEventProcessed('msg-1')).toBe(false);
    expect(state.markEventProcessed('msg-1')).toBe(false);
    expect(state.hasProcessedEvent('msg-1')).toBe(true);
  });

  it('treats distinct messages independently', () => {
    expect(state.markEventProcessed('msg-1')).toBe(true);
    expect(state.markEventProcessed('msg-2')).toBe(true);
  });
});

describe('quiet hours', () => {
  const quiet = (iso: string): boolean =>
    isWithinQuietHours(DateTime.fromISO(iso, { zone: ZONE }), '22:30', '07:30');

  it('recognises the window across midnight', () => {
    expect(quiet('2026-08-12T23:00:00')).toBe(true);
    expect(quiet('2026-08-12T02:00:00')).toBe(true);
    expect(quiet('2026-08-12T07:00:00')).toBe(true);
    expect(quiet('2026-08-12T22:30:00')).toBe(true);
  });

  it('is off during the day', () => {
    expect(quiet('2026-08-12T07:30:00')).toBe(false);
    expect(quiet('2026-08-12T12:00:00')).toBe(false);
    expect(quiet('2026-08-12T22:29:00')).toBe(false);
  });
});

describe('outbound gating', () => {
  function messenger(at: string) {
    const db = openMemoryDb();
    const state = new StateStore(db);
    const adapter = new FakeMessagingAdapter();
    const config = parseRuntimeConfig({
      timezone: ZONE,
      quiet_hours_start: '22:30',
      quiet_hours_end: '07:30',
      max_proactive_per_hour: '3',
    });
    const instance = new Messenger({
      adapter,
      state,
      config: () => config,
      logger: silentLogger,
      now: () => DateTime.fromISO(at, { zone: ZONE }).toJSDate(),
      targetHandle: OWNER,
    });
    return { instance, adapter, state, db };
  }

  it('suppresses a proactive message during quiet hours', async () => {
    const { instance, adapter } = messenger('2026-08-12T23:30:00');
    const result = await instance.send('Morning plan', { kind: 'morning' });

    expect(result.suppressed).toBe(true);
    expect(result.suppressedReason).toBe('quiet_hours');
    expect(adapter.sent).toHaveLength(0);
  });

  it('still answers a direct user command during quiet hours', async () => {
    const { instance, adapter } = messenger('2026-08-12T23:30:00');
    const result = await instance.send('Here is your task', { kind: 'reply' });

    expect(result.ok).toBe(true);
    expect(result.suppressed).toBeUndefined();
    expect(adapter.sent).toHaveLength(1);
  });

  it('sends a proactive message outside quiet hours', async () => {
    const { instance, adapter } = messenger('2026-08-12T08:00:00');
    const result = await instance.send('Morning plan', { kind: 'morning' });

    expect(result.ok).toBe(true);
    expect(adapter.sent).toHaveLength(1);
  });

  it('rate limits proactive messages but never user replies', async () => {
    const { instance, adapter } = messenger('2026-08-12T08:00:00');

    for (let i = 0; i < 3; i += 1) {
      expect((await instance.send(`nudge ${i}`, { kind: 'nudge' })).ok).toBe(true);
    }
    const blocked = await instance.send('one too many', { kind: 'nudge' });
    expect(blocked.suppressedReason).toBe('rate_limited');

    const reply = await instance.send('answering you', { kind: 'reply' });
    expect(reply.ok).toBe(true);
    expect(adapter.sent).toHaveLength(4);
  });

  it('refuses to send an empty message', async () => {
    const { instance, adapter } = messenger('2026-08-12T08:00:00');
    const result = await instance.send('   ', { kind: 'reply' });
    expect(result.ok).toBe(false);
    expect(adapter.sent).toHaveLength(0);
  });
});

describe('secret redaction in logs', () => {
  it('redacts secret-looking keys anywhere in the tree', () => {
    const result = redact({
      serverUrl: 'http://localhost:1234',
      password: 'hunter2',
      nested: { apiKey: 'sk-abc', client_secret: 'shh', safe: 'visible' },
    }) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('sk-abc');
    expect(JSON.stringify(result)).not.toContain('shh');
    expect(JSON.stringify(result)).toContain('visible');
  });

  it('redacts credentials embedded in URLs and bearer tokens', () => {
    expect(redactString('GET /api/v1/ping?password=hunter2')).not.toContain('hunter2');
    expect(redactString('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactString('key sk-ant-api03-verysecretvalue')).not.toContain('verysecretvalue');
    expect(redactString('AIzaSyD-ExampleGoogleApiKeyValue123')).not.toContain('ExampleGoogleApiKey');
  });

  it('keeps the readable prefix while removing the value', () => {
    // The point of redaction is debuggability, not blanking the whole line.
    const redacted = redactString('GET /api/v1/ping?password=hunter2');
    expect(redacted).toContain('password=');
    expect(redacted).not.toContain('hunter2');
  });

  it('survives circular structures', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular['self'] = circular;
    expect(() => redact(circular)).not.toThrow();
  });
});

describe('handle normalisation edge cases', () => {
  it('adds the US country code to a bare 10-digit number', () => {
    expect(normalizeHandle('5551234567')).toBe('+15551234567');
  });

  it('leaves an email untouched apart from case', () => {
    expect(normalizeHandle('  Foo@Bar.com ')).toBe('foo@bar.com');
  });
});
