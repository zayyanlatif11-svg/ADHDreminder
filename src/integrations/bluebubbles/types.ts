/**
 * The ONLY vocabulary the rest of the application is allowed to know about.
 * BlueBubbles payload shapes stop at this file's boundary.
 */

export interface InboundMessage {
  /** Stable per-message identifier from the bridge; used for idempotency. */
  messageId: string;
  /** Sender handle, e.g. "+15551234567" or "someone@example.com". */
  handle: string;
  /** Chat this arrived in; needed to reply into the same thread. */
  chatGuid: string | null;
  text: string;
  /** True when the bridge says this message was sent BY the linked account. */
  isFromMe: boolean;
  /** When the message was created, as an ISO string. */
  receivedAt: string;
  /** Untouched original, kept only for debugging/logging. */
  raw?: unknown;
}

export interface SendResult {
  ok: boolean;
  /** Bridge-assigned GUID, when the bridge returns one. */
  messageId?: string;
  error?: string;
}

export interface HealthStatus {
  ok: boolean;
  /** e.g. "1.9.9" when the server reports it. */
  serverVersion?: string;
  detail: string;
}

export interface ConversationIdentity {
  chatGuid: string;
  /** Handles participating in the chat, normalised. */
  participants: string[];
  displayName?: string;
}

/**
 * The contract the application codes against. Swapping bridges (or stubbing in
 * tests and simulation) means implementing these four methods and nothing else.
 */
export interface MessagingAdapter {
  sendMessage(text: string, opts?: { chatGuid?: string; handle?: string }): Promise<SendResult>;
  parseWebhook(body: unknown, headers?: Record<string, unknown>): InboundMessage | null;
  identifyConversation(handle: string): Promise<ConversationIdentity | null>;
  healthCheck(): Promise<HealthStatus>;
}

/**
 * Normalises a handle for comparison. Phone numbers keep only digits (with a
 * leading `+` inferred), emails are lower-cased. This is what makes the
 * allowlist robust to "+1 (555) 123-4567" vs "+15551234567".
 */
export function normalizeHandle(handle: string | null | undefined): string {
  if (!handle) return '';
  const trimmed = handle.trim();
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length === 0) return trimmed.toLowerCase();
  // US numbers are frequently written without the country code.
  const canonical = digits.length === 10 ? `1${digits}` : digits;
  return `+${canonical}`;
}

export function handlesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeHandle(a);
  const nb = normalizeHandle(b);
  return na !== '' && na === nb;
}
