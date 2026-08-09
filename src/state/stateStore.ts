import { createHash } from 'node:crypto';
import type { Db } from './db.js';

export interface ConversationState {
  currentTaskId: string | null;
  /** 0 = not stuck. 1/2/3 = progressively smaller next actions. */
  stuckLevel: number;
  /** The micro-action currently being asked for, so OPEN/READY can advance it. */
  pendingMicroStep: string | null;
  /** ISO timestamp; rescue mode is active while now < rescueUntil. */
  rescueUntil: string | null;
  mathQuestionId: string | null;
  mathAskedAt: string | null;
}

export interface MathReviewItem {
  questionId: string;
  concept: string;
  givenAnswer: string;
  reason: string;
  createdAt: string;
}

const EMPTY_STATE: ConversationState = {
  currentTaskId: null,
  stuckLevel: 0,
  pendingMicroStep: null,
  rescueUntil: null,
  mathQuestionId: null,
  mathAskedAt: null,
};

interface StateRow {
  current_task_id: string | null;
  stuck_level: number;
  pending_micro_step: string | null;
  rescue_until: string | null;
  math_question_id: string | null;
  math_asked_at: string | null;
}

export class StateStore {
  constructor(private readonly db: Db) {}

  // ---- webhook idempotency ------------------------------------------------

  /**
   * Returns true the first time a dedupe key is seen and false forever after.
   * The INSERT is the atomic test, so concurrent webhook deliveries of the same
   * message cannot both win.
   */
  markEventProcessed(dedupeKey: string, source = 'bluebubbles'): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_events (dedupe_key, source, received_at)
         VALUES (?, ?, datetime('now'))`,
      )
      .run(dedupeKey, source);
    return result.changes > 0;
  }

  hasProcessedEvent(dedupeKey: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS found FROM processed_events WHERE dedupe_key = ?`)
      .get(dedupeKey);
    return Boolean(row);
  }

  /** Housekeeping so the dedupe table does not grow without bound. */
  pruneProcessedEvents(olderThanDays = 30): number {
    return this.db
      .prepare(`DELETE FROM processed_events WHERE received_at < datetime('now', ?)`)
      .run(`-${olderThanDays} days`).changes;
  }

  // ---- once-per-day proactive messages ------------------------------------

  /**
   * Claims the right to send a given proactive message for a given local day.
   * Returns false if it was already sent — this is what stops duplicate morning
   * messages after a Mac wake, a restart, or two scheduler ticks racing.
   */
  claimDailySend(kind: string, dayKeyValue: string, body = ''): boolean {
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO sent_messages (kind, day_key, body_hash, sent_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(kind, dayKeyValue, hash);
    return result.changes > 0;
  }

  hasSentToday(kind: string, dayKeyValue: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS found FROM sent_messages WHERE kind = ? AND day_key = ?`)
      .get(kind, dayKeyValue);
    return Boolean(row);
  }

  /** Only used by tests and the `reset` maintenance path. */
  releaseDailySend(kind: string, dayKeyValue: string): void {
    this.db
      .prepare(`DELETE FROM sent_messages WHERE kind = ? AND day_key = ?`)
      .run(kind, dayKeyValue);
  }

  recordOutbound(kind: string, body: string): void {
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    this.db
      .prepare(
        `INSERT INTO sent_messages (kind, day_key, body_hash, sent_at)
         VALUES (?, NULL, ?, datetime('now'))`,
      )
      .run(kind, hash);
  }

  // ---- key/value ----------------------------------------------------------

  get(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value);
  }

  getJson<T>(key: string): T | null {
    const raw = this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  // ---- conversation state -------------------------------------------------

  getConversationState(): ConversationState {
    const row = this.db
      .prepare(
        `SELECT current_task_id, stuck_level, pending_micro_step, rescue_until,
                math_question_id, math_asked_at
         FROM conversation_state WHERE id = 1`,
      )
      .get() as StateRow | undefined;
    if (!row) return { ...EMPTY_STATE };
    return {
      currentTaskId: row.current_task_id,
      stuckLevel: row.stuck_level,
      pendingMicroStep: row.pending_micro_step,
      rescueUntil: row.rescue_until,
      mathQuestionId: row.math_question_id,
      mathAskedAt: row.math_asked_at,
    };
  }

  updateConversationState(patch: Partial<ConversationState>): ConversationState {
    const next = { ...this.getConversationState(), ...patch };
    this.db
      .prepare(
        `UPDATE conversation_state
         SET current_task_id = ?, stuck_level = ?, pending_micro_step = ?,
             rescue_until = ?, math_question_id = ?, math_asked_at = ?,
             updated_at = datetime('now')
         WHERE id = 1`,
      )
      .run(
        next.currentTaskId,
        next.stuckLevel,
        next.pendingMicroStep,
        next.rescueUntil,
        next.mathQuestionId,
        next.mathAskedAt,
      );
    return next;
  }

  resetStuck(): void {
    this.updateConversationState({ stuckLevel: 0, pendingMicroStep: null });
  }

  // ---- rate limiting ------------------------------------------------------

  /**
   * Fixed-window counter. Deliberately simple: this guards a single-user
   * personal system against runaway loops, not against an adversary.
   */
  consumeRateLimit(bucket: string, limit: number, windowSeconds: number, now: Date): boolean {
    const windowStart = new Date(
      Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000,
    ).toISOString();

    this.db
      .prepare(
        `INSERT INTO rate_limit (bucket, window_start, count) VALUES (?, ?, 0)
         ON CONFLICT(bucket, window_start) DO NOTHING`,
      )
      .run(bucket, windowStart);

    const row = this.db
      .prepare(`SELECT count FROM rate_limit WHERE bucket = ? AND window_start = ?`)
      .get(bucket, windowStart) as { count: number } | undefined;

    if ((row?.count ?? 0) >= limit) return false;

    this.db
      .prepare(`UPDATE rate_limit SET count = count + 1 WHERE bucket = ? AND window_start = ?`)
      .run(bucket, windowStart);
    return true;
  }

  // ---- math answers we could not confidently grade ------------------------

  queueMathReview(item: Omit<MathReviewItem, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO math_review_queue
           (question_id, concept, given_answer, reason, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run(item.questionId, item.concept, item.givenAnswer, item.reason);
  }

  listMathReview(): MathReviewItem[] {
    const rows = this.db
      .prepare(
        `SELECT question_id, concept, given_answer, reason, created_at
         FROM math_review_queue ORDER BY created_at DESC`,
      )
      .all() as Array<{
      question_id: string;
      concept: string;
      given_answer: string;
      reason: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      questionId: r.question_id,
      concept: r.concept,
      givenAnswer: r.given_answer,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }
}
