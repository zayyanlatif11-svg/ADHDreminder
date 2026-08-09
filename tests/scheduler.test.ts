import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DateTime } from 'luxon';
import { createSimulation, type SimulationHarness } from '../src/cli/simulate.js';
import { MORNING_KIND, runMorningJob } from '../src/scheduler/jobs.js';
import { silentLogger } from '../src/utils/logger.js';
import { openMemoryDb } from '../src/state/db.js';
import { StateStore } from '../src/state/stateStore.js';

const ZONE = 'America/Los_Angeles';

function jobDeps(harness: SimulationHarness) {
  return { agent: harness.agent, messenger: harness.messenger, logger: silentLogger };
}

describe('morning message scheduling', () => {
  let harness: SimulationHarness;

  afterEach(() => {
    harness.close();
  });

  it('sends exactly once per day, however many times the tick runs', async () => {
    harness = createSimulation({ at: '2026-08-12T08:05:00' });

    const first = await runMorningJob(jobDeps(harness));
    expect(first.sent).toBe(true);
    expect(harness.adapter.sent).toHaveLength(1);

    for (let i = 0; i < 5; i += 1) {
      const repeat = await runMorningJob(jobDeps(harness));
      expect(repeat.sent).toBe(false);
      expect(repeat.reason).toBe('already_sent');
    }
    expect(harness.adapter.sent).toHaveLength(1);
  });

  it('does not send before the configured morning time', async () => {
    harness = createSimulation({ at: '2026-08-12T06:00:00' });

    const result = await runMorningJob(jobDeps(harness));
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('not_yet');
    expect(harness.adapter.sent).toHaveLength(0);
  });

  it('catches up after the Mac was asleep, if it is still early enough', async () => {
    // Machine was off at 08:00 and woke at 10:30 — still before the cutoff.
    harness = createSimulation({ at: '2026-08-12T10:30:00' });

    const result = await runMorningJob(jobDeps(harness));
    expect(result.sent).toBe(true);
    expect(harness.adapter.sent).toHaveLength(1);
  });

  it('sends the catch-up only once', async () => {
    harness = createSimulation({ at: '2026-08-12T10:30:00' });

    await runMorningJob(jobDeps(harness));
    const second = await runMorningJob(jobDeps(harness));

    expect(second.sent).toBe(false);
    expect(harness.adapter.sent).toHaveLength(1);
  });

  it('does not send a stale morning message late in the day', async () => {
    harness = createSimulation({ at: '2026-08-12T18:00:00' });

    const result = await runMorningJob(jobDeps(harness));
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('too_late');
    expect(harness.adapter.sent).toHaveLength(0);
  });

  it('does not send a late message on a later tick either', async () => {
    harness = createSimulation({ at: '2026-08-12T18:00:00' });

    await runMorningJob(jobDeps(harness));
    harness.setNow(DateTime.fromISO('2026-08-12T19:00:00', { zone: ZONE }));
    const later = await runMorningJob(jobDeps(harness));

    expect(later.sent).toBe(false);
    expect(harness.adapter.sent).toHaveLength(0);
  });

  it('suppresses the message during quiet hours but keeps the daily claim', async () => {
    harness = createSimulation({ at: '2026-08-12T23:00:00' });

    const result = await runMorningJob(jobDeps(harness), { force: true });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('quiet_hours');
    expect(harness.adapter.sent).toHaveLength(0);

    // The claim is retained so the message cannot escape later that night.
    expect(harness.state.hasSentToday(MORNING_KIND, '2026-08-12')).toBe(true);
  });

  it('sends again on a new day', async () => {
    harness = createSimulation({ at: '2026-08-12T08:05:00' });
    await runMorningJob(jobDeps(harness));
    expect(harness.adapter.sent).toHaveLength(1);

    harness.setNow(DateTime.fromISO('2026-08-13T08:05:00', { zone: ZONE }));
    const nextDay = await runMorningJob(jobDeps(harness));

    expect(nextDay.sent).toBe(true);
    expect(harness.adapter.sent).toHaveLength(2);
  });

  it('produces a message with at most the configured number of tasks', async () => {
    harness = createSimulation({ at: '2026-08-12T08:05:00' });
    const result = await runMorningJob(jobDeps(harness));

    const numbered = (result.body ?? '').match(/^\d\./gm) ?? [];
    expect(numbered.length).toBeGreaterThan(0);
    expect(numbered.length).toBeLessThanOrEqual(3);
  });
});

describe('daily send claims', () => {
  it('is atomic — only the first caller wins', () => {
    const db = openMemoryDb();
    const state = new StateStore(db);

    expect(state.claimDailySend('morning', '2026-08-12')).toBe(true);
    expect(state.claimDailySend('morning', '2026-08-12')).toBe(false);
    expect(state.claimDailySend('morning', '2026-08-13')).toBe(true);
    // Different message kinds are tracked independently.
    expect(state.claimDailySend('weekly_health', '2026-08-12')).toBe(true);

    db.close();
  });

  it('can release a claim so a failed send is retried', () => {
    const db = openMemoryDb();
    const state = new StateStore(db);

    state.claimDailySend('morning', '2026-08-12');
    state.releaseDailySend('morning', '2026-08-12');
    expect(state.claimDailySend('morning', '2026-08-12')).toBe(true);

    db.close();
  });
});

describe('rate limiting', () => {
  it('enforces a fixed window and resets in the next one', () => {
    const db = openMemoryDb();
    const state = new StateStore(db);
    const base = new Date('2026-08-12T09:00:00Z');

    expect(state.consumeRateLimit('test', 2, 60, base)).toBe(true);
    expect(state.consumeRateLimit('test', 2, 60, base)).toBe(true);
    expect(state.consumeRateLimit('test', 2, 60, base)).toBe(false);

    const nextWindow = new Date(base.getTime() + 61_000);
    expect(state.consumeRateLimit('test', 2, 60, nextWindow)).toBe(true);

    db.close();
  });
});

describe('rollover integration', () => {
  let harness: SimulationHarness;

  beforeEach(() => {
    harness = createSimulation({ at: '2026-08-12T08:05:00' });
  });

  afterEach(() => {
    harness.close();
  });

  it('does not roll every missed task into today\'s plan', async () => {
    const context = await harness.agent.buildContext();
    const yesterday = context.now.minus({ days: 1 }).toFormat('yyyy-LL-dd');

    // Yesterday everything was planned and nothing got done.
    await harness.repository.writeDailyPlan(
      yesterday,
      context.tasks.slice(0, 5).map((task, index) => ({
        date: yesterday,
        rank: index + 1,
        taskId: task.id,
        selectedAt: context.now.minus({ days: 1 }).toISO() ?? '',
        status: 'planned' as const,
        reason: 'test',
        startedAt: null,
        completedAt: null,
      })),
    );

    const result = await harness.agent.runRollover(context);
    expect(result.promoted).toBeLessThanOrEqual(3);

    const morning = await runMorningJob(jobDeps(harness));
    const numbered = (morning.body ?? '').match(/^\d\./gm) ?? [];
    expect(numbered.length).toBeLessThanOrEqual(3);
  });
});
