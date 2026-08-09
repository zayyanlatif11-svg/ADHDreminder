import { randomUUID } from 'node:crypto';
import { parseBlueBubblesWebhook } from './webhook.js';
import type {
  ConversationIdentity,
  HealthStatus,
  InboundMessage,
  MessagingAdapter,
  SendResult,
} from './types.js';

/**
 * In-memory messaging adapter used by `npm run simulate` and the test suite.
 * It records outbound messages instead of sending them, so the full command
 * flow can be exercised without a Mac, a bridge, or a phone.
 */
export class FakeMessagingAdapter implements MessagingAdapter {
  readonly sent: Array<{ text: string; chatGuid?: string; handle?: string; at: Date }> = [];
  healthy = true;

  constructor(private readonly onSend?: (text: string) => void) {}

  async sendMessage(
    text: string,
    opts: { chatGuid?: string; handle?: string } = {},
  ): Promise<SendResult> {
    this.sent.push({ text, ...opts, at: new Date() });
    this.onSend?.(text);
    return { ok: true, messageId: `fake-${randomUUID()}` };
  }

  parseWebhook(body: unknown): InboundMessage | null {
    return parseBlueBubblesWebhook(body);
  }

  async identifyConversation(handle: string): Promise<ConversationIdentity | null> {
    return { chatGuid: `iMessage;-;${handle}`, participants: [handle] };
  }

  async healthCheck(): Promise<HealthStatus> {
    return this.healthy
      ? { ok: true, detail: 'simulated bridge', serverVersion: 'simulated' }
      : { ok: false, detail: 'simulated bridge is offline' };
  }

  lastMessage(): string | undefined {
    return this.sent.at(-1)?.text;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
