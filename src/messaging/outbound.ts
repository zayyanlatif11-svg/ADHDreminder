import { DateTime } from 'luxon';
import type { MessagingAdapter, SendResult } from '../integrations/bluebubbles/types.js';
import type { StateStore } from '../state/stateStore.js';
import type { RuntimeConfig } from '../config/runtimeConfig.js';
import type { Logger } from '../utils/logger.js';
import { isWithinQuietHours } from '../utils/time.js';

export type MessageKind =
  | 'morning'
  | 'weekly_health'
  | 'reply'
  | 'test'
  | 'auto_rescue'
  | 'nudge';

/** Replies to a direct user command are never suppressed. */
const USER_INITIATED: ReadonlySet<MessageKind> = new Set<MessageKind>(['reply', 'test']);

export interface SendOptions {
  kind: MessageKind;
  /** Overrides the configured destination (used by diagnostics). */
  chatGuid?: string;
  handle?: string;
  /** Bypass quiet hours. Only diagnostics should set this. */
  force?: boolean;
}

export interface OutboundResult extends SendResult {
  suppressed?: boolean;
  suppressedReason?: 'quiet_hours' | 'rate_limited' | 'dry_run';
}

export interface MessengerDeps {
  adapter: MessagingAdapter;
  state: StateStore;
  config: () => RuntimeConfig;
  logger: Logger;
  now: () => Date;
  targetChatGuid?: string | null;
  targetHandle?: string | null;
  dryRun?: boolean;
}

/**
 * Single choke point for everything the agent says. Quiet hours, rate limits
 * and dry-run all live here so no feature can accidentally bypass them.
 */
export class Messenger {
  constructor(private readonly deps: MessengerDeps) {}

  private zonedNow(): DateTime {
    return DateTime.fromJSDate(this.deps.now(), { zone: this.deps.config().timezone });
  }

  isQuietNow(): boolean {
    const config = this.deps.config();
    return isWithinQuietHours(this.zonedNow(), config.quiet_hours_start, config.quiet_hours_end);
  }

  async send(text: string, options: SendOptions): Promise<OutboundResult> {
    const { state, logger, config } = this.deps;
    const body = text.trim();
    if (body === '') return { ok: false, error: 'refusing to send an empty message' };

    const userInitiated = USER_INITIATED.has(options.kind);

    if (!userInitiated && !options.force && this.isQuietNow()) {
      logger.info({ kind: options.kind }, 'proactive message suppressed by quiet hours');
      return { ok: false, suppressed: true, suppressedReason: 'quiet_hours' };
    }

    if (!userInitiated) {
      const allowed = state.consumeRateLimit(
        'proactive',
        config().max_proactive_per_hour,
        3600,
        this.deps.now(),
      );
      if (!allowed) {
        logger.warn({ kind: options.kind }, 'proactive message suppressed by rate limit');
        return { ok: false, suppressed: true, suppressedReason: 'rate_limited' };
      }
    }

    if (this.deps.dryRun) {
      logger.info({ kind: options.kind, preview: body.slice(0, 80) }, 'dry run — not sending');
      return { ok: true, suppressed: true, suppressedReason: 'dry_run' };
    }

    const result = await this.deps.adapter.sendMessage(body, {
      chatGuid: options.chatGuid ?? this.deps.targetChatGuid ?? undefined,
      handle: options.handle ?? this.deps.targetHandle ?? undefined,
    });

    if (result.ok) state.recordOutbound(options.kind, body);
    return result;
  }

  /**
   * Sends a proactive message at most once per local day for the given kind.
   * The claim is taken BEFORE the send so a crash mid-send cannot produce a
   * duplicate on the next tick; a failed send releases the claim.
   */
  async sendOncePerDay(
    text: string,
    options: SendOptions & { dayKey: string },
  ): Promise<OutboundResult> {
    const claimed = this.deps.state.claimDailySend(options.kind, options.dayKey, text);
    if (!claimed) {
      this.deps.logger.info(
        { kind: options.kind, dayKey: options.dayKey },
        'already sent today — skipping',
      );
      return { ok: false, suppressed: true };
    }
    const result = await this.send(text, options);
    if (!result.ok && !result.suppressed) {
      this.deps.state.releaseDailySend(options.kind, options.dayKey);
    }
    // A quiet-hours or rate-limit suppression keeps the claim: we do not want a
    // "morning" message escaping at 23:00 because the 08:00 attempt was muted.
    return result;
  }
}
