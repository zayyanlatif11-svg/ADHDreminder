import { handlesMatch, type InboundMessage } from '../integrations/bluebubbles/types.js';

export interface AuthorizationPolicy {
  authorizedHandles: string[];
  /** When set, messages must also arrive in this chat. */
  chatGuid?: string | null;
}

export type RejectionReason =
  | 'from_bot'
  | 'unauthorized_handle'
  | 'wrong_chat'
  | 'empty_text'
  | 'duplicate';

export interface AuthorizationResult {
  allowed: boolean;
  reason?: RejectionReason;
}

/**
 * The loop-prevention rule.
 *
 * `isFromMe` is true for anything the linked Apple account sent — which
 * includes every message this agent sends. Acting on those would create an
 * infinite reply loop, so they are dropped unconditionally and BEFORE the
 * allowlist is consulted.
 *
 * This is also why a self-messaging setup (user and bot on one Apple ID) is
 * called out in SETUP.md: with one account, the user's own commands are also
 * `isFromMe`, and there is no way to tell them apart from the bot's output.
 */
export function authorizeInbound(
  message: InboundMessage,
  policy: AuthorizationPolicy,
): AuthorizationResult {
  if (message.isFromMe) {
    return { allowed: false, reason: 'from_bot' };
  }

  const isKnownSender = policy.authorizedHandles.some((allowed) =>
    handlesMatch(allowed, message.handle),
  );
  if (!isKnownSender) {
    return { allowed: false, reason: 'unauthorized_handle' };
  }

  if (policy.chatGuid && message.chatGuid && message.chatGuid !== policy.chatGuid) {
    return { allowed: false, reason: 'wrong_chat' };
  }

  if (message.text.trim() === '') {
    return { allowed: false, reason: 'empty_text' };
  }

  return { allowed: true };
}
