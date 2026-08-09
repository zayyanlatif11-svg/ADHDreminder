import { DateTime } from 'luxon';
import bank from './bank.json' with { type: 'json' };
import { checkAnswer, type CheckResult, type QuestionType } from './checker.js';
import type { MathMasteryRow } from '../tasks/types.js';
import type { TaskRepository } from '../sheets/repository.js';
import type { StateStore } from '../state/stateStore.js';

export interface MathQuestion {
  id: string;
  concept: string;
  prompt: string;
  answer: string;
  type: QuestionType;
  difficulty: number;
}

export interface ConceptMeta {
  id: string;
  label: string;
  order: number;
}

const CONCEPTS: ConceptMeta[] = (bank.concepts as ConceptMeta[]).slice();
const QUESTIONS: MathQuestion[] = (bank.questions as MathQuestion[]).slice();

export function conceptLabel(conceptId: string): string {
  return CONCEPTS.find((concept) => concept.id === conceptId)?.label ?? conceptId;
}

export function allConcepts(): ConceptMeta[] {
  return CONCEPTS.slice();
}

export function questionById(id: string): MathQuestion | null {
  return QUESTIONS.find((question) => question.id === id) ?? null;
}

/**
 * Selection weight for a concept.
 *
 * Weak concepts appear more often; mastered ones fade out but never vanish
 * entirely, and a concept that is due for review gets a large boost. The
 * earlier foundations (signed numbers, fractions) also carry a small standing
 * bonus, because they are the ones blocking everything downstream.
 */
export function conceptWeight(
  concept: ConceptMeta,
  mastery: MathMasteryRow | undefined,
  now: DateTime,
): number {
  const level = mastery?.mastery ?? 0;
  let weight = 1 + (1 - level) * 4;

  // Foundations first: an unmastered early concept outranks a later one.
  weight += Math.max(0, (CONCEPTS.length - concept.order) * 0.15);

  if (mastery?.nextReview) {
    const due = DateTime.fromISO(mastery.nextReview);
    if (due.isValid && due <= now) weight += 3;
  }
  // Never practised at all — surface it.
  if (!mastery || mastery.attempts === 0) weight += 1.5;

  return Math.max(0.1, weight);
}

/** Deterministic when a `random` function is injected, which tests rely on. */
export function selectConcept(
  masteryRows: MathMasteryRow[],
  now: DateTime,
  random: () => number = Math.random,
): ConceptMeta {
  const byConcept = new Map(masteryRows.map((row) => [row.concept, row]));
  const weights = CONCEPTS.map((concept) => ({
    concept,
    weight: conceptWeight(concept, byConcept.get(concept.id), now),
  }));
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);

  let roll = random() * total;
  for (const entry of weights) {
    roll -= entry.weight;
    if (roll <= 0) return entry.concept;
  }
  return weights[0]?.concept ?? (CONCEPTS[0] as ConceptMeta);
}

/**
 * Picks a question within a concept, scaled to current mastery so the user is
 * not handed a hard factoring problem before the easy ones are solid.
 */
export function selectQuestion(
  conceptId: string,
  mastery: MathMasteryRow | undefined,
  recentIds: string[],
  random: () => number = Math.random,
): MathQuestion | null {
  const level = mastery?.mastery ?? 0;
  const targetDifficulty = level < 0.35 ? 1 : level < 0.7 ? 2 : 3;

  const pool = QUESTIONS.filter((question) => question.concept === conceptId);
  if (pool.length === 0) return null;

  const recent = new Set(recentIds);
  const fresh = pool.filter((question) => !recent.has(question.id));
  const candidates = fresh.length > 0 ? fresh : pool;

  const atLevel = candidates.filter((question) => question.difficulty <= targetDifficulty);
  const finalPool = atLevel.length > 0 ? atLevel : candidates;

  const index = Math.min(finalPool.length - 1, Math.floor(random() * finalPool.length));
  return finalPool[index] ?? null;
}

/**
 * SM-2-flavoured spacing, simplified. Correct answers push the next review
 * further out; a mistake brings the concept back within a day.
 */
export function updateMastery(
  existing: MathMasteryRow | undefined,
  concept: string,
  correct: boolean,
  now: DateTime,
): MathMasteryRow {
  const attempts = (existing?.attempts ?? 0) + 1;
  const correctCount = (existing?.correct ?? 0) + (correct ? 1 : 0);
  const previous = existing?.mastery ?? 0;

  // Exponential moving average — recent performance matters more than history.
  const mastery = Math.max(0, Math.min(1, previous + (correct ? 0.15 : -0.2) * (1 - previous * 0.5)));

  const intervalDays = correct ? Math.min(21, Math.max(1, Math.round(1 + mastery * 14))) : 1;

  return {
    concept,
    mastery,
    attempts,
    correct: correctCount,
    lastPracticed: now.toISO(),
    nextReview: now.plus({ days: intervalDays }).toISO(),
    notes: existing?.notes ?? null,
    rowNumber: existing?.rowNumber,
  };
}

export interface AskResult {
  question: MathQuestion;
  conceptLabel: string;
}

export interface AnswerResult {
  check: CheckResult;
  question: MathQuestion;
  masteryAfter: MathMasteryRow | null;
  /** The next question, when the session continues. */
  next: AskResult | null;
}

export interface MathServiceDeps {
  repository: TaskRepository;
  state: StateStore;
  now: () => DateTime;
  random?: () => number;
}

const RECENT_KEY = 'math:recent_question_ids';
const RECENT_LIMIT = 12;

export class MathService {
  constructor(private readonly deps: MathServiceDeps) {}

  private recentIds(): string[] {
    return this.deps.state.getJson<string[]>(RECENT_KEY) ?? [];
  }

  private pushRecent(id: string): void {
    const next = [id, ...this.recentIds().filter((existing) => existing !== id)].slice(
      0,
      RECENT_LIMIT,
    );
    this.deps.state.setJson(RECENT_KEY, next);
  }

  /** Chooses and records the next question. One question at a time, always. */
  async ask(): Promise<AskResult | null> {
    const now = this.deps.now();
    const rows = await this.deps.repository.listMastery();
    const random = this.deps.random ?? Math.random;

    const concept = selectConcept(rows, now, random);
    const mastery = rows.find((row) => row.concept === concept.id);
    const question = selectQuestion(concept.id, mastery, this.recentIds(), random);
    if (!question) return null;

    this.deps.state.updateConversationState({
      mathQuestionId: question.id,
      mathAskedAt: now.toISO(),
    });
    this.pushRecent(question.id);

    return { question, conceptLabel: conceptLabel(concept.id) };
  }

  /** True when the user currently owes an answer to a math question. */
  pendingQuestion(): MathQuestion | null {
    const state = this.deps.state.getConversationState();
    return state.mathQuestionId ? questionById(state.mathQuestionId) : null;
  }

  clearPending(): void {
    this.deps.state.updateConversationState({ mathQuestionId: null, mathAskedAt: null });
  }

  async answer(rawAnswer: string, options: { continueSession: boolean }): Promise<AnswerResult | null> {
    const question = this.pendingQuestion();
    if (!question) return null;

    const now = this.deps.now();
    const check = checkAnswer(rawAnswer, question.answer, question.type);

    // An ungradeable answer is logged for manual review, never guessed at.
    if (check.verdict === 'unknown') {
      this.deps.state.queueMathReview({
        questionId: question.id,
        concept: question.concept,
        givenAnswer: rawAnswer.slice(0, 200),
        reason: check.reason ?? 'ungradeable',
      });
      this.clearPending();
      return { check, question, masteryAfter: null, next: null };
    }

    const rows = await this.deps.repository.listMastery();
    const existing = rows.find((row) => row.concept === question.concept);
    const updated = updateMastery(existing, question.concept, check.verdict === 'correct', now);
    await this.deps.repository.upsertMastery(updated);

    this.clearPending();
    const next = options.continueSession ? await this.ask() : null;

    return { check, question, masteryAfter: updated, next };
  }

  /**
   * How many math minutes to recommend today. Never zero when it can be helped:
   * a ten-minute day still beats a skipped day.
   */
  recommendedMinutes(options: {
    rescueActive: boolean;
    busyDay: boolean;
    minimumMinutes: number;
    hardDeadlineToday: boolean;
  }): number {
    if (options.rescueActive) {
      return options.hardDeadlineToday ? 0 : Math.max(10, options.minimumMinutes);
    }
    if (options.busyDay) return Math.max(options.minimumMinutes, 15);
    return 30;
  }
}
