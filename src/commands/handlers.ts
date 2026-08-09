import { DateTime } from 'luxon';
import type { AgentService } from '../agent/agentService.js';
import type { AgentContext } from '../agent/context.js';
import { todayKey } from '../agent/context.js';
import { parseAdd, parseSnooze } from './parser.js';
import {
  HELP_TEXT,
  formatAdded,
  formatDone,
  formatMathFeedback,
  formatMathQuestion,
  formatMathUngraded,
  formatMorningMessage,
  formatNoTimeAvailable,
  formatSnoozed,
  formatStuck,
  formatWhatNow,
  shortTitle,
} from '../messaging/formatter.js';
import { buildDailyPlan } from '../prioritization/planner.js';
import { rankTasks } from '../prioritization/engine.js';
import { isOpen, type Task } from '../tasks/types.js';
import { humanDuration } from '../utils/time.js';

/** Handlers receive a prepared context so they never re-read the world. */
export interface HandlerDeps {
  agent: AgentService;
  context: AgentContext;
}

// ---- TODAY ----------------------------------------------------------------

export async function handleToday({ agent, context }: HandlerDeps): Promise<string> {
  const plan = buildDailyPlan(context.tasks, {
    now: context.now,
    zone: context.zone,
    config: context.config,
    courses: context.courses,
    rescueActive: context.rescueActive,
    academicMinimumMet: context.academicMinimumMet,
    freeMinutesToday: context.freeMinutesToday,
  });

  await agent.getOrBuildPlan(context, { rebuild: true });

  return formatMorningMessage({
    now: context.now,
    zone: context.zone,
    entries: plan.entries,
    keystone: plan.keystone,
    courses: context.courses,
    rescue: plan.rescue,
  });
}

// ---- WHAT NOW -------------------------------------------------------------

export async function handleWhatNow({ agent, context }: HandlerDeps): Promise<string> {
  const selection = await agent.selectNow(context);

  if (!selection) {
    // Distinguish "you're busy right now" from "nothing left to do".
    const { ranked } = rankTasks(context.tasks, {
      now: context.now,
      zone: context.zone,
      config: context.config,
      courses: context.courses,
      rescueActive: context.rescueActive,
      academicMinimumMet: context.academicMinimumMet,
    });
    if (ranked.length === 0) {
      return ['Nothing required right now.', '', 'Reply MATH for 10 minutes of practice.'].join('\n');
    }
    const nextFree = context.freeWindows[0]?.start ?? null;
    return formatNoTimeAvailable(nextFree, context.zone);
  }

  await agent.setCurrentTask(selection.task.id);
  await agent.repository.updateTask(selection.task.id, {
    status: 'active',
    lastPromptedAt: context.now.toISO(),
  });
  await agent.logEvent('what_now', { taskId: selection.task.id, command: 'WHAT NOW' });

  return formatWhatNow({
    task: selection.task,
    courses: context.courses,
    availableMinutes: selection.availableMinutes,
    nextEventTitle: selection.nextEventTitle,
    ...(selection.shrunkTo !== undefined ? { shrunkTo: selection.shrunkTo } : {}),
    actionOverride: selection.action,
  });
}

// ---- DONE -----------------------------------------------------------------

export async function handleDone({ agent, context }: HandlerDeps): Promise<string> {
  const wasLockedBefore = !context.academicMinimumMet;
  const completed = await agent.markCurrentTaskDone(context);

  if (!completed) {
    return ['Nothing was marked active.', '', 'Reply WHAT NOW to pick something up.'].join('\n');
  }

  // Re-read the world: completing a task can unlock startup work and changes
  // what "next" means.
  const refreshed = await agent.buildContext();

  // Progress is counted against the plan that was actually committed for today,
  // read directly rather than through getOrBuildPlan — otherwise finishing the
  // LAST task would rebuild the plan and report "0/N done" at the exact moment
  // the user deserves to see "3/3".
  const storedPlan = await agent.repository.getDailyPlan(todayKey(refreshed));
  const byId = new Map(refreshed.tasks.map((t) => [t.id, t]));
  const planTasks = storedPlan
    .filter((entry) => entry.status !== 'dropped')
    .map((entry) => byId.get(entry.taskId))
    .filter((t): t is Task => t !== undefined);

  const completedCount = planTasks.filter((t) => !isOpen(t)).length;
  const total = Math.max(planTasks.length, completedCount, 1);

  const next = planTasks.find(isOpen) ?? null;
  const startupUnlocked =
    wasLockedBefore &&
    refreshed.academicMinimumMet &&
    refreshed.config.startup_unlock_enabled &&
    refreshed.tasks.some((task) => task.category === 'startup' && isOpen(task));

  if (next) await agent.resolveNextAction(next);

  return formatDone({
    completed,
    completedCount,
    totalCount: total,
    next,
    courses: refreshed.courses,
    startupUnlocked,
  });
}

// ---- STUCK ----------------------------------------------------------------

/**
 * Deterministic shrinking ladder. The LLM is not consulted — the sizes here
 * are the therapeutic point, and they must be identical every time.
 */
export function microActionFor(task: Task, level: number): string {
  const noun = shortTitle(task.title, 40);
  // Sheet-authored actions usually end in a period; appending to them directly
  // reads as broken, so trailing punctuation is trimmed before extending.
  const base = task.nextAction?.trim().replace(/[.!]+$/, '');

  if (level <= 1) {
    // ~5 minutes: one unit of real work.
    if (base) return `${base} — that one only.`;
    return `Open ${noun} and do the first item only.`;
  }
  if (level === 2) {
    // ~60 seconds: get it on screen, solve nothing.
    return `Open ${noun} on your screen.`;
  }
  // Absurdly small: physical presence only.
  return `Put ${noun} in front of you.`;
}

export async function handleStuck({ agent, context }: HandlerDeps): Promise<string> {
  const state = agent.state.getConversationState();

  let task: Task | null = state.currentTaskId
    ? (context.tasks.find((t) => t.id === state.currentTaskId) ?? null)
    : null;

  if (!task || !isOpen(task)) {
    const selection = await agent.selectNow(context);
    task = selection?.task ?? null;
    if (task) await agent.setCurrentTask(task.id);
  }

  if (!task) {
    return ['Nothing is active.', '', 'Reply WHAT NOW and I will pick one thing.'].join('\n');
  }

  const level = Math.min(3, state.stuckLevel + 1);
  const action = microActionFor(task, level);

  agent.state.updateConversationState({
    currentTaskId: task.id,
    stuckLevel: level,
    pendingMicroStep: action,
  });
  await agent.repository.updateTask(task.id, {
    avoidanceCount: task.avoidanceCount + (level === 1 ? 1 : 0),
  });
  await agent.logEvent('stuck', { taskId: task.id, command: 'STUCK', result: `level=${level}` });

  return formatStuck(task, level, action);
}

// ---- OPEN / READY ---------------------------------------------------------

export async function handleAdvance({ agent, context }: HandlerDeps): Promise<string> {
  const state = agent.state.getConversationState();
  const task = state.currentTaskId
    ? (context.tasks.find((t) => t.id === state.currentTaskId) ?? null)
    : null;

  if (!task) {
    return ['Nothing is active.', '', 'Reply WHAT NOW to start something.'].join('\n');
  }

  // Advancing means the tiny step worked — climb back UP the ladder toward
  // real work rather than shrinking further.
  const nextLevel = Math.max(0, state.stuckLevel - 1);
  agent.state.updateConversationState({ stuckLevel: nextLevel, pendingMicroStep: null });
  await agent.logEvent('advance', { taskId: task.id, result: `level=${nextLevel}` });

  if (nextLevel === 0) {
    const action = await agent.resolveNextAction(task);
    return ['Good.', '', 'Now:', action, '', 'Reply DONE when finished.'].join('\n');
  }

  const action = microActionFor(task, nextLevel);
  return ['Good.', '', 'Now:', action, '', 'Reply DONE when finished.'].join('\n');
}

// ---- SNOOZE ---------------------------------------------------------------

export async function handleSnooze(
  { agent, context }: HandlerDeps,
  argument: string,
): Promise<string> {
  const state = agent.state.getConversationState();
  let task: Task | null = state.currentTaskId
    ? (context.tasks.find((t) => t.id === state.currentTaskId) ?? null)
    : null;

  if (!task || !isOpen(task)) {
    const plan = await agent.getOrBuildPlan(context);
    task = plan.entries.find(isOpen) ?? null;
  }
  if (!task) {
    return 'Nothing to snooze right now.';
  }

  const { until } = parseSnooze(argument, context.now);
  await agent.snoozeTask(task, until);
  agent.state.updateConversationState({
    currentTaskId: null,
    stuckLevel: 0,
    pendingMicroStep: null,
  });

  return formatSnoozed(task, until, context.zone);
}

// ---- RESCUE ---------------------------------------------------------------

export async function handleRescue({ agent, context }: HandlerDeps): Promise<string> {
  await agent.activateRescue(context);

  const rescueContext: AgentContext = { ...context, rescueActive: true };
  const plan = buildDailyPlan(rescueContext.tasks, {
    now: rescueContext.now,
    zone: rescueContext.zone,
    config: rescueContext.config,
    courses: rescueContext.courses,
    rescueActive: true,
    academicMinimumMet: rescueContext.academicMinimumMet,
    freeMinutesToday: rescueContext.freeMinutesToday,
  });

  await agent.getOrBuildPlan(rescueContext, { rebuild: true });

  if (plan.entries.length === 0) {
    return ['RESCUE MODE', '', 'Nothing critical is outstanding.', '', 'Rest.'].join('\n');
  }

  return formatMorningMessage({
    now: rescueContext.now,
    zone: rescueContext.zone,
    entries: plan.entries,
    keystone: plan.keystone,
    courses: rescueContext.courses,
    rescue: true,
  });
}

// ---- ADD ------------------------------------------------------------------

export async function handleAdd(
  { agent, context }: HandlerDeps,
  argument: string,
): Promise<string> {
  if (argument.trim() === '') {
    return ['What should I add?', '', 'Example: ADD finish calc worksheet tomorrow'].join('\n');
  }

  const parsed = parseAdd(argument, context.now);
  const course = parsed.course;
  const courseRow = course ? context.courses.find((c) => c.courseId === course) : undefined;

  const task = await agent.createTask({
    title: parsed.title,
    category: parsed.category,
    course,
    dueAt: parsed.dueAt?.toISO() ?? null,
    estimatedMinutes: parsed.estimatedMinutes ?? 30,
    importance: parsed.category === 'academic' ? 4 : 3,
    courseRisk: courseRow?.riskLevel ?? null,
    status: 'ready',
    source: 'imessage',
    // Nothing the user typed is ever discarded.
    notes: `Original: ${argument.trim()}`,
  });

  return formatAdded(task, parsed.residue);
}

// ---- MATH -----------------------------------------------------------------

export async function handleMath({ agent }: HandlerDeps): Promise<string> {
  const asked = await agent.mathService.ask();
  if (!asked) return 'No math questions available.';
  return formatMathQuestion(asked.conceptLabel, asked.question.prompt);
}

/** Called when a reply arrives while a math question is outstanding. */
export async function handleMathAnswer(
  { agent }: HandlerDeps,
  answer: string,
): Promise<string | null> {
  const result = await agent.mathService.answer(answer, { continueSession: true });
  if (!result) return null;

  if (result.check.verdict === 'unknown') {
    return formatMathUngraded(result.question.answer);
  }

  await agent.logEvent('math_answer', {
    result: result.check.verdict,
    details: result.question.id,
  });

  return formatMathFeedback(
    result.check.verdict === 'correct',
    result.question.answer,
    result.next ? { conceptLabel: result.next.conceptLabel, prompt: result.next.question.prompt } : null,
  );
}

// ---- STATUS / HELP --------------------------------------------------------

export async function handleStatus({ agent, context }: HandlerDeps): Promise<string> {
  const state = agent.state.getConversationState();
  const current = state.currentTaskId
    ? context.tasks.find((t) => t.id === state.currentTaskId)
    : null;

  const openCount = context.tasks.filter(isOpen).length;

  return [
    'STATUS',
    '',
    `Time: ${context.now.toFormat('ccc h:mm a')}`,
    `Free today: ${humanDuration(context.freeMinutesToday)}`,
    `Rescue: ${context.rescueActive ? 'ON' : 'off'}`,
    `Academic minimum: ${context.academicMinimumMet ? 'met' : 'not met'}`,
    `Open tasks: ${openCount}`,
    `Current: ${current ? shortTitle(current.title, 40) : 'none'}`,
    `Stuck level: ${state.stuckLevel}`,
  ].join('\n');
}

export function handleHelp(): string {
  return HELP_TEXT;
}

/** Small helper used by the morning job and TODAY. */
export function planDateKey(context: AgentContext): string {
  return todayKey(context);
}

export function nowInZone(zone: string, at: Date): DateTime {
  return DateTime.fromJSDate(at, { zone });
}
