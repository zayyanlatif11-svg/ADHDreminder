import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DateTime } from 'luxon';
import { createSimulation, type SimulationHarness } from '../src/cli/simulate.js';
import { parseAdd, parseCommand, parseSnooze } from '../src/commands/parser.js';

const ZONE = 'America/Los_Angeles';
const NOW = DateTime.fromISO('2026-08-12T09:00:00', { zone: ZONE });

describe('command parsing', () => {
  it('is case-insensitive and tolerant of spacing', () => {
    expect(parseCommand('what now').name).toBe('what_now');
    expect(parseCommand('WHAT NOW').name).toBe('what_now');
    expect(parseCommand('  WhAtNoW  ').name).toBe('what_now');
    expect(parseCommand('wn').name).toBe('what_now');
  });

  it('recognises every documented command', () => {
    expect(parseCommand('TODAY').name).toBe('today');
    expect(parseCommand('DONE').name).toBe('done');
    expect(parseCommand('STUCK').name).toBe('stuck');
    expect(parseCommand('OPEN').name).toBe('advance');
    expect(parseCommand('READY').name).toBe('advance');
    expect(parseCommand('SNOOZE 30m').name).toBe('snooze');
    expect(parseCommand('RESCUE').name).toBe('rescue');
    expect(parseCommand('ADD do the thing').name).toBe('add');
    expect(parseCommand('MATH').name).toBe('math');
    expect(parseCommand('HELP').name).toBe('help');
  });

  it('accepts natural phrasings', () => {
    expect(parseCommand("I'm stuck").name).toBe('unknown');
    expect(parseCommand('stuck').name).toBe('stuck');
    expect(parseCommand('finished').name).toBe('done');
    expect(parseCommand('overwhelmed').name).toBe('rescue');
    expect(parseCommand('too much').name).toBe('rescue');
  });

  it('separates the argument from the command word', () => {
    const command = parseCommand('ADD finish calc worksheet tomorrow');
    expect(command.name).toBe('add');
    expect(command.argument).toBe('finish calc worksheet tomorrow');
  });

  it('falls back to unknown rather than throwing', () => {
    expect(parseCommand('asdfghjkl').name).toBe('unknown');
    expect(parseCommand('').name).toBe('unknown');
  });

  it('caps absurdly long input', () => {
    const command = parseCommand('x'.repeat(50_000));
    expect(command.raw.length).toBeLessThanOrEqual(1000);
  });
});

describe('SNOOZE parsing', () => {
  it('handles relative durations', () => {
    expect(parseSnooze('30m', NOW).until.toISO()).toBe(NOW.plus({ minutes: 30 }).toISO());
    expect(parseSnooze('2h', NOW).until.toISO()).toBe(NOW.plus({ hours: 2 }).toISO());
    expect(parseSnooze('45 minutes', NOW).until.toISO()).toBe(NOW.plus({ minutes: 45 }).toISO());
  });

  it('handles clock times', () => {
    const result = parseSnooze('4pm', NOW);
    expect(result.until.hour).toBe(16);
    expect(result.until.hasSame(NOW, 'day')).toBe(true);
  });

  it('handles "until 7" by dropping the filler word', () => {
    const result = parseSnooze('until 7', NOW);
    // 07:00 has passed at 09:00, so it resolves to 19:00 the same day.
    expect(result.until.hour).toBe(19);
  });

  it('handles tomorrow', () => {
    const result = parseSnooze('tomorrow', NOW);
    expect(result.until.day).toBe(NOW.plus({ days: 1 }).day);
    expect(result.until.hour).toBe(9);
  });

  it('always returns a future time, never a past one', () => {
    for (const input of ['30m', '2h', '4pm', 'tomorrow', 'until 7', '', 'gibberish']) {
      expect(parseSnooze(input, NOW).until.toMillis()).toBeGreaterThan(NOW.toMillis());
    }
  });
});

describe('ADD parsing', () => {
  it('extracts a title, a date, and a duration', () => {
    const result = parseAdd('finish accounting worksheet tomorrow', NOW);
    expect(result.title.toLowerCase()).toContain('accounting worksheet');
    expect(result.dueAt?.day).toBe(NOW.plus({ days: 1 }).day);
    expect(result.category).toBe('academic');
  });

  it('extracts an explicit duration', () => {
    const result = parseAdd('calc practice 30 min', NOW);
    expect(result.estimatedMinutes).toBe(30);
    expect(result.category).toBe('academic');
    expect(result.course).toBe('CALC');
  });

  it('classifies a recruiting task', () => {
    const result = parseAdd('apply to Evercore internship Friday', NOW);
    expect(result.category).toBe('recruiting');
    expect(result.dueAt).not.toBeNull();
  });

  it('treats a bare date as end of day, not midnight', () => {
    const result = parseAdd('submit essay Friday', NOW);
    expect(result.dueAt?.hour).toBe(23);
  });

  it('never discards unparsed text', () => {
    const original = 'do the weird thing with the blue folder by next thursday';
    const result = parseAdd(original, NOW);
    expect(result.title.length).toBeGreaterThan(0);
    // Whatever the parser stripped is preserved for the notes field.
    expect(result.residue === null || result.residue === original).toBe(true);
  });

  it('falls back to the raw text when nothing can be parsed', () => {
    const result = parseAdd('zzzz', NOW);
    expect(result.title).toBe('zzzz');
    expect(result.dueAt).toBeNull();
  });
});

describe('end-to-end command flow', () => {
  let harness: SimulationHarness;

  beforeEach(() => {
    harness = createSimulation({ at: '2026-08-12T09:00:00' });
  });

  afterEach(() => {
    harness.close();
  });

  it('TODAY returns a capped plan', async () => {
    const { reply } = await harness.router.route('TODAY');
    expect(reply).toContain('TOP');
    const numbered = reply.match(/^\d\./gm) ?? [];
    expect(numbered.length).toBeLessThanOrEqual(3);
  });

  it('WHAT NOW returns exactly one task', async () => {
    const { reply } = await harness.router.route('WHAT NOW');
    expect(reply).toContain('Do:');
    expect(reply).toContain('Start:');
    // One task means one "Do:" block.
    expect((reply.match(/Do:/g) ?? []).length).toBe(1);
  });

  it('WHAT NOW mentions the free window it is planning around', async () => {
    const { reply } = await harness.router.route('WHAT NOW');
    expect(reply).toMatch(/You have (about )?\d+/);
  });

  it('DONE marks the active task complete and names the next one', async () => {
    await harness.router.route('WHAT NOW');
    const { reply } = await harness.router.route('DONE');

    expect(reply).toMatch(/\d\/\d done\./);
    const completed = (await harness.repository.listTasks()).filter(
      (task) => task.status === 'completed',
    );
    expect(completed.length).toBe(1);
    expect(completed[0]?.completedAt).not.toBeNull();
  });

  it('reports full progress when the last planned task is completed', async () => {
    await harness.router.route('TODAY');
    const context = await harness.agent.buildContext();
    const planned = await harness.repository.getDailyPlan(context.now.toFormat('yyyy-LL-dd'));
    expect(planned.length).toBeGreaterThan(0);

    // Drive the planned tasks specifically. WHAT NOW is deliberately free to
    // pick a higher-ranked task that is not on the plan, which would make this
    // assertion about something else.
    let last = '';
    for (const entry of planned) {
      await harness.agent.setCurrentTask(entry.taskId);
      last = (await harness.router.route('DONE')).reply;
    }

    // Finishing the final item must read "N/N done.", never "0/N" — the plan
    // must not be silently rebuilt out from under the progress count.
    expect(last).toContain(`${planned.length}/${planned.length} done.`);
    expect(last).not.toContain('0/');
    expect(last).toContain("That's the list.");
  });

  it('STUCK escalates through three levels and then holds', async () => {
    await harness.router.route('WHAT NOW');

    const first = await harness.router.route('STUCK');
    expect(harness.state.getConversationState().stuckLevel).toBe(1);
    expect(first.reply).toContain('Reply DONE when finished.');

    const second = await harness.router.route('STUCK');
    expect(harness.state.getConversationState().stuckLevel).toBe(2);
    expect(second.reply).toContain("Reply OPEN when it's on screen.");

    const third = await harness.router.route('STUCK');
    expect(harness.state.getConversationState().stuckLevel).toBe(3);
    expect(third.reply).toContain('Reply READY.');

    await harness.router.route('STUCK');
    expect(harness.state.getConversationState().stuckLevel).toBe(3);
  });

  it('READY climbs back up the ladder instead of shrinking further', async () => {
    await harness.router.route('WHAT NOW');
    await harness.router.route('STUCK');
    await harness.router.route('STUCK');
    expect(harness.state.getConversationState().stuckLevel).toBe(2);

    await harness.router.route('READY');
    expect(harness.state.getConversationState().stuckLevel).toBe(1);
  });

  it('completing a task resets the stuck ladder', async () => {
    await harness.router.route('WHAT NOW');
    await harness.router.route('STUCK');
    await harness.router.route('STUCK');
    await harness.router.route('DONE');

    expect(harness.state.getConversationState().stuckLevel).toBe(0);
  });

  it('SNOOZE moves a task without losing it', async () => {
    await harness.router.route('WHAT NOW');
    const before = harness.state.getConversationState().currentTaskId;
    expect(before).not.toBeNull();

    const { reply } = await harness.router.route('SNOOZE 2h');
    expect(reply).toContain('Moved:');

    const snoozed = (await harness.repository.listTasks()).find((task) => task.id === before);
    expect(snoozed?.status).toBe('snoozed');
    expect(snoozed?.snoozedUntil).not.toBeNull();
    // Still present in the sheet — snoozing is not deleting.
    expect(snoozed).toBeDefined();
  });

  it('ADD captures a task and preserves the original text', async () => {
    const { reply } = await harness.router.route('ADD finish calc worksheet tomorrow');
    expect(reply).toContain('Got it.');

    const created = (await harness.repository.listTasks()).find(
      (task) => task.source === 'imessage',
    );
    expect(created).toBeDefined();
    expect(created?.notes).toContain('finish calc worksheet tomorrow');
    expect(created?.category).toBe('academic');
  });

  it('RESCUE cuts the day down to at most two tasks', async () => {
    const { reply } = await harness.router.route('RESCUE');
    expect(reply).toContain('RESCUE MODE');

    const numbered = reply.match(/^\d\./gm) ?? [];
    expect(numbered.length).toBeLessThanOrEqual(2);
    expect(reply).not.toContain('DiliPilot');
  });

  it('MATH asks exactly one question at a time', async () => {
    const { reply } = await harness.router.route('MATH');
    expect(reply).toContain('MATH —');
    expect(reply).toContain('Reply with your answer.');
    expect((reply.match(/\?/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it('treats a bare number as an answer while a math question is pending', async () => {
    await harness.router.route('MATH');
    const pending = harness.agent.mathService.pendingQuestion();
    expect(pending).not.toBeNull();

    const { reply, command } = await harness.router.route(pending!.answer);
    expect(command.name).toBe('answer');
    expect(reply).toContain('Correct.');
  });

  it('marks a wrong math answer without pretending it was right', async () => {
    await harness.router.route('MATH');
    const { reply } = await harness.router.route('999999');
    expect(reply).toContain('Not quite');
  });

  it('HELP returns only the command list', async () => {
    const { reply } = await harness.router.route('HELP');
    expect(reply).toContain('COMMANDS');
    expect(reply).toContain('WHAT NOW');
    expect(reply.length).toBeLessThan(500);
  });

  it('answers unknown input with a short menu instead of an error', async () => {
    const { reply } = await harness.router.route('qwertyuiop');
    expect(reply).toContain('WHAT NOW');
    expect(reply.toLowerCase()).not.toContain('error');
  });

  it('never leaks a stack trace to the user', async () => {
    for (const input of ['TODAY', 'WHAT NOW', 'DONE', 'STUCK', 'SNOOZE', 'RESCUE', 'MATH', 'ADD']) {
      const { reply } = await harness.router.route(input);
      expect(reply).not.toContain('at Object.');
      expect(reply).not.toContain('.ts:');
    }
  });
});
