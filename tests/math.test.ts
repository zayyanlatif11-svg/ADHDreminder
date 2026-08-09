import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DateTime } from 'luxon';
import { checkAnswer, parsePair, parseRational } from '../src/math/checker.js';
import {
  allConcepts,
  conceptWeight,
  questionById,
  selectConcept,
  selectQuestion,
  updateMastery,
  MathService,
} from '../src/math/mathService.js';
import bank from '../src/math/bank.json' with { type: 'json' };
import { MemoryRepository } from '../src/sheets/memoryRepository.js';
import { openMemoryDb, type Db } from '../src/state/db.js';
import { StateStore } from '../src/state/stateStore.js';
import type { MathMasteryRow } from '../src/tasks/types.js';

const ZONE = 'America/Los_Angeles';
const NOW = DateTime.fromISO('2026-08-12T09:00:00', { zone: ZONE });

function mastery(overrides: Partial<MathMasteryRow> & { concept: string }): MathMasteryRow {
  return {
    mastery: 0,
    attempts: 0,
    correct: 0,
    lastPracticed: null,
    nextReview: null,
    notes: null,
    ...overrides,
  };
}

describe('answer checking', () => {
  it('grades integers', () => {
    expect(checkAnswer('3', '3', 'integer').verdict).toBe('correct');
    expect(checkAnswer('-14', '-14', 'integer').verdict).toBe('correct');
    expect(checkAnswer('4', '3', 'integer').verdict).toBe('incorrect');
  });

  it('tolerates how people actually reply', () => {
    expect(checkAnswer('x = 3', '3', 'integer').verdict).toBe('correct');
    expect(checkAnswer(' 3 ', '3', 'integer').verdict).toBe('correct');
    expect(checkAnswer('the answer is -7', '-7', 'integer').verdict).toBe('correct');
  });

  it('grades fractions, including equivalent forms', () => {
    expect(checkAnswer('3/4', '3/4', 'fraction').verdict).toBe('correct');
    expect(checkAnswer('6/8', '3/4', 'fraction').verdict).toBe('correct');
    expect(checkAnswer('0.75', '3/4', 'fraction').verdict).toBe('correct');
    expect(checkAnswer('2/3', '3/4', 'fraction').verdict).toBe('incorrect');
  });

  it('grades factoring pairs regardless of order or notation', () => {
    expect(checkAnswer('2,3', '2,3', 'pair').verdict).toBe('correct');
    expect(checkAnswer('3,2', '2,3', 'pair').verdict).toBe('correct');
    expect(checkAnswer('(x+2)(x+3)', '2,3', 'pair').verdict).toBe('correct');
    expect(checkAnswer('2,5', '2,3', 'pair').verdict).toBe('incorrect');
  });

  it('returns unknown rather than falsely grading something it cannot read', () => {
    expect(checkAnswer('', '3', 'integer').verdict).toBe('unknown');
    expect(checkAnswer('I have no idea what this even means honestly, can you explain it again please', '3', 'integer').verdict).toBe('unknown');
    expect(checkAnswer('not sure', '3', 'integer').verdict).toBe('unknown');
    expect(checkAnswer('maybe', '2,3', 'pair').verdict).toBe('unknown');
  });

  it('never reports incorrect when it could not parse the answer', () => {
    const result = checkAnswer('???', '3', 'integer');
    expect(result.verdict).not.toBe('incorrect');
    expect(result.reason).toBeDefined();
  });

  it('parses rationals and pairs directly', () => {
    expect(parseRational('3/4')).toEqual({ numerator: 3, denominator: 4 });
    expect(parseRational('-6/8')).toEqual({ numerator: -3, denominator: 4 });
    expect(parseRational('nope')).toBeNull();
    expect(parsePair('  -3 , 3 ')).toEqual([-3, 3]);
    expect(parsePair('7')).toBeNull();
  });
});

describe('question bank integrity', () => {
  it('covers every concept the module claims to teach', () => {
    const covered = new Set(bank.questions.map((question) => question.concept));
    for (const concept of allConcepts()) {
      expect(covered.has(concept.id)).toBe(true);
    }
  });

  it('has a self-consistent, gradeable answer for every question', () => {
    for (const question of bank.questions) {
      const result = checkAnswer(
        question.answer,
        question.answer,
        question.type as 'integer' | 'fraction' | 'pair',
      );
      expect(
        result.verdict,
        `question ${question.id} is not gradeable: ${result.reason ?? ''}`,
      ).toBe('correct');
    }
  });

  it('uses unique ids', () => {
    const ids = bank.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('starts with the foundations the user actually needs', () => {
    const ids = allConcepts().map((c) => c.id);
    expect(ids.slice(0, 4)).toEqual([
      'signed_numbers',
      'fractions',
      'exponents',
      'factoring',
    ]);
  });
});

describe('spaced repetition', () => {
  it('weights weak concepts more heavily than mastered ones', () => {
    const concept = allConcepts()[0]!;
    const weak = conceptWeight(concept, mastery({ concept: concept.id, mastery: 0.1, attempts: 5 }), NOW);
    const strong = conceptWeight(concept, mastery({ concept: concept.id, mastery: 0.95, attempts: 20 }), NOW);

    expect(weak).toBeGreaterThan(strong);
  });

  it('boosts a concept that is due for review', () => {
    const concept = allConcepts()[2]!;
    const due = conceptWeight(
      concept,
      mastery({ concept: concept.id, mastery: 0.5, attempts: 5, nextReview: NOW.minus({ days: 1 }).toISO() }),
      NOW,
    );
    const notDue = conceptWeight(
      concept,
      mastery({ concept: concept.id, mastery: 0.5, attempts: 5, nextReview: NOW.plus({ days: 5 }).toISO() }),
      NOW,
    );
    expect(due).toBeGreaterThan(notDue);
  });

  it('keeps a mastered concept in rotation rather than dropping it entirely', () => {
    const concept = allConcepts()[0]!;
    const weight = conceptWeight(
      concept,
      mastery({ concept: concept.id, mastery: 1, attempts: 50, correct: 50 }),
      NOW,
    );
    expect(weight).toBeGreaterThan(0);
  });

  it('pushes the next review further out on success and pulls it in on failure', () => {
    const first = updateMastery(undefined, 'fractions', true, NOW);
    expect(first.attempts).toBe(1);
    expect(first.correct).toBe(1);
    expect(first.mastery).toBeGreaterThan(0);

    const wrong = updateMastery(first, 'fractions', false, NOW);
    expect(wrong.mastery).toBeLessThan(first.mastery);
    expect(wrong.correct).toBe(1);
    expect(wrong.attempts).toBe(2);

    // A missed concept comes back within a day.
    const reviewAfterMiss = DateTime.fromISO(wrong.nextReview!);
    expect(reviewAfterMiss.diff(NOW, 'days').days).toBeLessThanOrEqual(1.01);
  });

  it('keeps mastery inside 0..1', () => {
    let row = updateMastery(undefined, 'exponents', true, NOW);
    for (let i = 0; i < 40; i += 1) row = updateMastery(row, 'exponents', true, NOW);
    expect(row.mastery).toBeLessThanOrEqual(1);

    for (let i = 0; i < 40; i += 1) row = updateMastery(row, 'exponents', false, NOW);
    expect(row.mastery).toBeGreaterThanOrEqual(0);
  });

  it('serves easier questions while mastery is low', () => {
    const easy = selectQuestion('signed_numbers', mastery({ concept: 'signed_numbers', mastery: 0.05 }), [], () => 0.99);
    expect(easy?.difficulty).toBeLessThanOrEqual(1);
  });

  it('avoids repeating a question that was just asked', () => {
    const recent = bank.questions
      .filter((q) => q.concept === 'signed_numbers')
      .slice(0, 3)
      .map((q) => q.id);

    const chosen = selectQuestion('signed_numbers', mastery({ concept: 'signed_numbers', mastery: 0.5 }), recent, () => 0.1);
    expect(recent).not.toContain(chosen?.id);
  });

  it('selects a concept deterministically for a given random draw', () => {
    const rows = allConcepts().map((c) => mastery({ concept: c.id, mastery: 0.5, attempts: 3 }));
    const a = selectConcept(rows, NOW, () => 0.3);
    const b = selectConcept(rows, NOW, () => 0.3);
    expect(a.id).toBe(b.id);
  });
});

describe('MathService', () => {
  let db: Db;
  let service: MathService;
  let repository: MemoryRepository;
  let state: StateStore;

  beforeEach(() => {
    db = openMemoryDb();
    state = new StateStore(db);
    repository = new MemoryRepository();
    service = new MathService({
      repository,
      state,
      now: () => NOW,
      random: () => 0.42,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('asks one question and records it as pending', async () => {
    const asked = await service.ask();
    expect(asked).not.toBeNull();
    expect(service.pendingQuestion()?.id).toBe(asked!.question.id);
  });

  it('records mastery after a graded answer', async () => {
    const asked = await service.ask();
    const result = await service.answer(asked!.question.answer, { continueSession: false });

    expect(result?.check.verdict).toBe('correct');
    const rows = await repository.listMastery();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.correct).toBe(1);
    expect(service.pendingQuestion()).toBeNull();
  });

  it('queues an ungradeable answer for manual review instead of marking it wrong', async () => {
    await service.ask();
    const result = await service.answer('honestly I have completely forgotten how any of this works', {
      continueSession: false,
    });

    expect(result?.check.verdict).toBe('unknown');
    // Mastery must NOT be touched by an answer we could not grade.
    expect(await repository.listMastery()).toHaveLength(0);
    expect(state.listMathReview()).toHaveLength(1);
  });

  it('continues the session with a follow-up question when asked to', async () => {
    const asked = await service.ask();
    const result = await service.answer(asked!.question.answer, { continueSession: true });
    expect(result?.next).not.toBeNull();
    expect(service.pendingQuestion()).not.toBeNull();
  });

  it('recommends a non-zero math floor even on a rescue day', () => {
    const minutes = service.recommendedMinutes({
      rescueActive: true,
      busyDay: true,
      minimumMinutes: 10,
      hardDeadlineToday: false,
    });
    expect(minutes).toBeGreaterThanOrEqual(10);
  });

  it('yields entirely to an immediate deadline on a rescue day', () => {
    const minutes = service.recommendedMinutes({
      rescueActive: true,
      busyDay: true,
      minimumMinutes: 10,
      hardDeadlineToday: true,
    });
    expect(minutes).toBe(0);
  });

  it('recommends more on a normal day than a busy one', () => {
    const normal = service.recommendedMinutes({
      rescueActive: false,
      busyDay: false,
      minimumMinutes: 10,
      hardDeadlineToday: false,
    });
    const busy = service.recommendedMinutes({
      rescueActive: false,
      busyDay: true,
      minimumMinutes: 10,
      hardDeadlineToday: false,
    });
    expect(normal).toBeGreaterThan(busy);
    expect(normal).toBeGreaterThanOrEqual(25);
  });

  it('resolves questions by id', () => {
    expect(questionById('sn-1')?.concept).toBe('signed_numbers');
    expect(questionById('does-not-exist')).toBeNull();
  });
});
