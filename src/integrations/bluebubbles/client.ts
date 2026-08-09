import { randomUUID } from 'node:crypto';
import type { Logger } from '../../utils/logger.js';
import { parseBlueBubblesWebhook } from './webhook.js';
import {
  handlesMatch,
  normalizeHandle,
  type ConversationIdentity,
  type HealthStatus,
  type InboundMessage,
  type MessagingAdapter,
  type SendResult,
} from './types.js';

export interface BlueBubblesOptions {
  serverUrl: string;
  password: string;
  /** `apple-script` needs no Private API and works with SIP enabled. */
  sendMethod?: 'apple-script' | 'private-api';
  defaultChatGuid?: string | undefined;
  defaultHandle?: string | undefined;
  logger: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Endpoint paths are collected here rather than scattered through the client so
 * that a BlueBubbles API change is a single-place edit.
 */
const ROUTES = {
  ping: '/api/v1/ping',
  serverInfo: '/api/v1/server/info',
  sendText: '/api/v1/message/text',
  chatQuery: '/api/v1/chat/query',
} as const;

interface BbEnvelope<T> {
  status?: number;
  message?: string;
  error?: { type?: string; message?: string } | string;
  data?: T;
}

export class BlueBubblesClient implements MessagingAdapter {
  private readonly baseUrl: string;
  private readonly password: string;
  private readonly sendMethod: 'apple-script' | 'private-api';
  private readonly defaultChatGuid: string | undefined;
  private readonly defaultHandle: string | undefined;
  private readonly log: Logger;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BlueBubblesOptions) {
    this.baseUrl = options.serverUrl.replace(/\/+$/, '');
    this.password = options.password;
    this.sendMethod = options.sendMethod ?? 'apple-script';
    this.defaultChatGuid = options.defaultChatGuid;
    this.defaultHandle = options.defaultHandle;
    this.log = options.logger.child({ module: 'bluebubbles' });
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Auth travels as a query param, which is what the BlueBubbles server expects. */
  private url(route: string, params: Record<string, string | number> = {}): string {
    const url = new URL(this.baseUrl + route);
    url.searchParams.set('password', this.password);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(
    route: string,
    init: RequestInit = {},
    params: Record<string, string | number> = {},
  ): Promise<BbEnvelope<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.doFetch(this.url(route, params), {
        ...init,
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
      const text = await response.text();
      let parsed: BbEnvelope<T> = {};
      if (text.trim() !== '') {
        try {
          parsed = JSON.parse(text) as BbEnvelope<T>;
        } catch {
          // Non-JSON body (an HTML error page from a wrong URL, typically).
          parsed = { message: text.slice(0, 200) };
        }
      }
      if (!response.ok) {
        const detail =
          typeof parsed.error === 'string'
            ? parsed.error
            : (parsed.error?.message ?? parsed.message ?? `HTTP ${response.status}`);
        throw new Error(`BlueBubbles ${route} failed: ${detail}`);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.request<string>(ROUTES.ping);
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'unknown error contacting BlueBubbles',
      };
    }
    // Version is a nice-to-have; a server that pings but has no /server/info
    // is still healthy enough to use.
    let serverVersion: string | undefined;
    try {
      const info = await this.request<Record<string, unknown>>(ROUTES.serverInfo);
      const version = info.data?.['os_version'] ?? info.data?.['server_version'];
      if (typeof version === 'string') serverVersion = version;
    } catch {
      serverVersion = undefined;
    }
    return { ok: true, serverVersion, detail: 'BlueBubbles reachable' };
  }

  async sendMessage(
    text: string,
    opts: { chatGuid?: string; handle?: string } = {},
  ): Promise<SendResult> {
    const chatGuid = opts.chatGuid ?? this.defaultChatGuid ?? this.guidForHandle(opts.handle);
    if (!chatGuid) {
      return { ok: false, error: 'No chatGuid or handle available to send to' };
    }
    const tempGuid = `temp-${randomUUID()}`;
    try {
      const response = await this.request<Record<string, unknown>>(ROUTES.sendText, {
        method: 'POST',
        body: JSON.stringify({
          chatGuid,
          tempGuid,
          message: text,
          method: this.sendMethod,
        }),
      });
      const messageId = response.data?.['guid'];
      this.log.info({ chatGuid, chars: text.length }, 'sent iMessage');
      return { ok: true, messageId: typeof messageId === 'string' ? messageId : tempGuid };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'send failed';
      this.log.error({ chatGuid, error: message }, 'failed to send iMessage');
      return { ok: false, error: message };
    }
  }

  /**
   * BlueBubbles addresses ad-hoc chats as `iMessage;-;<handle>`. The `any`
   * service prefix lets the server fall back to SMS if iMessage is unavailable.
   */
  private guidForHandle(handle?: string): string | undefined {
    const target = handle ?? this.defaultHandle;
    if (!target) return undefined;
    return `iMessage;-;${target}`;
  }

  async identifyConversation(handle: string): Promise<ConversationIdentity | null> {
    try {
      const response = await this.request<Array<Record<string, unknown>>>(ROUTES.chatQuery, {
        method: 'POST',
        body: JSON.stringify({ limit: 200, offset: 0, with: ['participants'] }),
      });
      const chats = Array.isArray(response.data) ? response.data : [];
      for (const chat of chats) {
        const participants = Array.isArray(chat['participants']) ? chat['participants'] : [];
        const addresses = participants
          .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>)['address'] : null))
          .filter((a): a is string => typeof a === 'string');

        // Only a 1:1 chat is a safe reply target — replying into a group would
        // leak the user's plan to other people.
        if (addresses.length === 1 && handlesMatch(addresses[0], handle)) {
          const guid = chat['guid'];
          if (typeof guid === 'string') {
            return {
              chatGuid: guid,
              participants: addresses.map(normalizeHandle),
              displayName:
                typeof chat['displayName'] === 'string' ? chat['displayName'] : undefined,
            };
          }
        }
      }
      return null;
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'chat lookup failed',
      );
      return null;
    }
  }

  parseWebhook(body: unknown): InboundMessage | null {
    return parseBlueBubblesWebhook(body);
  }
}
