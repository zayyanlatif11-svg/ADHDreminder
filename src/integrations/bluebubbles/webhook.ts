import type { InboundMessage } from './types.js';

/**
 * Defensive parsing of the BlueBubbles webhook body.
 *
 * BlueBubbles has changed payload details across server versions, so nothing
 * here assumes a field exists. Every access is guarded, several field names are
 * accepted for the same concept, and anything that does not yield a usable
 * message returns `null` instead of throwing. A malformed webhook must never
 * take the agent down.
 *
 * Observed envelope (server >= 1.0):
 *   { "type": "new-message", "data": { ...message... } }
 * Some deployments and proxies post the message object directly.
 */

const MESSAGE_EVENT_TYPES = new Set(['new-message', 'updated-message']);

/** Max characters we will accept from a single inbound message. */
const MAX_TEXT_LENGTH = 2000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.toLowerCase());
  return false;
}

/**
 * BlueBubbles reports timestamps as epoch milliseconds in most versions and as
 * ISO strings in others. Anything unparseable falls back to "now".
 */
function parseTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Values below this threshold are seconds, not milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function extractHandle(data: Record<string, unknown>): string {
  const handle = asRecord(data['handle']);
  if (handle) {
    const address = firstString(handle, ['address', 'id', 'uncanonicalizedId']);
    if (address) return address;
  }
  const direct = firstString(data, ['handleId', 'from', 'address', 'sender']);
  if (direct) return direct;

  // Fall back to the first non-me participant of the chat.
  const chats = data['chats'];
  if (Array.isArray(chats)) {
    for (const chat of chats) {
      const chatRecord = asRecord(chat);
      const participants = chatRecord?.['participants'];
      if (Array.isArray(participants)) {
        for (const participant of participants) {
          const record = asRecord(participant);
          const address = record ? firstString(record, ['address', 'id']) : null;
          if (address) return address;
        }
      }
    }
  }
  return '';
}

function extractChatGuid(data: Record<string, unknown>): string | null {
  const chats = data['chats'];
  if (Array.isArray(chats)) {
    for (const chat of chats) {
      const record = asRecord(chat);
      const guid = record ? firstString(record, ['guid', 'chatIdentifier']) : null;
      if (guid) return guid;
    }
  }
  const chat = asRecord(data['chat']);
  if (chat) {
    const guid = firstString(chat, ['guid', 'chatIdentifier']);
    if (guid) return guid;
  }
  return firstString(data, ['chatGuid']);
}

/**
 * BlueBubbles delivers message text either as a plain `text` field or, on newer
 * servers, split across `attributedBody` parts. We only need the plain text.
 */
function extractText(data: Record<string, unknown>): string {
  const direct = firstString(data, ['text', 'body', 'message']);
  if (direct !== null) return direct;

  const attributed = data['attributedBody'];
  if (Array.isArray(attributed)) {
    const parts: string[] = [];
    for (const entry of attributed) {
      const record = asRecord(entry);
      const value = record ? firstString(record, ['string', 'text']) : null;
      if (value) parts.push(value);
    }
    if (parts.length > 0) return parts.join(' ');
  }
  return '';
}

/**
 * Strips the Unicode object-replacement / attachment placeholders iMessage
 * inserts, which would otherwise defeat command matching.
 */
function cleanText(text: string): string {
  return (
    text
      // U+FFFC object-replacement (attachment placeholder), U+FFFD replacement
      // character, and U+00A0 non-breaking space. Written as escapes so the
      // intent is visible and no invisible character sits in the source.
      .replace(/[\uFFFC\uFFFD\u00A0]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TEXT_LENGTH)
  );
}

export function parseBlueBubblesWebhook(body: unknown): InboundMessage | null {
  const envelope = asRecord(body);
  if (!envelope) return null;

  const eventType = firstString(envelope, ['type', 'event']);
  // When there is an envelope type we recognise, use its `data`. When there is
  // a type we do NOT recognise (typing indicators, read receipts, group
  // renames), drop it. When there is no type at all, treat the body as the
  // message itself.
  let data: Record<string, unknown> | null;
  if (eventType === null) {
    data = envelope;
  } else if (MESSAGE_EVENT_TYPES.has(eventType)) {
    data = asRecord(envelope['data']) ?? envelope;
  } else {
    return null;
  }
  if (!data) return null;

  const messageId = firstString(data, ['guid', 'originalROWID', 'id', 'tempGuid']);
  if (!messageId) return null;

  const text = cleanText(extractText(data));
  const handle = extractHandle(data);

  return {
    messageId,
    handle,
    chatGuid: extractChatGuid(data),
    text,
    isFromMe: asBoolean(data['isFromMe']),
    receivedAt: parseTimestamp(data['dateCreated'] ?? data['date'] ?? data['dateDelivered']),
    raw: body,
  };
}
