import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Logger } from '../utils/logger.js';
import type { TaskRepository } from '../sheets/repository.js';
import type { StateStore } from '../state/stateStore.js';
import type { CalendarSource, StudyBlockWriter } from '../calendar/types.js';
import type { AiProvider } from '../ai/provider.js';
import { MathService } from '../math/mathService.js';
import { parseRuntimeConfig, type RuntimeConfig } from '../config/runtimeConfig.js';
import {
  computeFreeWindows,
  currentFreeWindow,
  nextFixedEvent,
  totalFreeMinutes,
} from '../calendar/freeWindows.js';
import { detectAssignments } from '../calendar/assignmentDetection.js';
import { buildDailyPlan } from '../prioritization/planner.js';
import { computeAcademicMinimumMet, rankTasks } from '../prioritization/engine.js';
import { assessAutoRescue, isRescueActive, rescueExpiry } from '../prioritization/rescue.js';
import { evaluateRollover, rolloverPatch } from '../prioritization/rollover.js';
import { selectForWindow, shrinkAction } from '../prioritization/calendarFit.js';
import type { Task } from '../tasks/types.js';
import { isOpen } from '../tasks/types.js';
import type { AgentContext } from './context.js';
import { hardDeadlineToday, todayKey } from './context.js';
import { windowMinutes } from '../utils/time.js';

export interface AgentServiceDeps {
  repository: TaskRepository;
  calendar: CalendarSource;
  state: StateStore;
  math: MathService;
  ai: AiProvider;
  logger: Logger;
  now: () => Date;
  studyBlockWriter?: StudyBlockWriter | null;
  studyBlockCalendarName?: string;
}

/**
 * The application core. Command handlers and the scheduler both drive this;
 * neither of them talks to Sheets, Calendar or the bridge directly.
 */
export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  get repository(): TaskRepository {
    return this.deps.repository;
  }

  get state(): StateStore {
    return this.deps.state;
  }

  get mathService(): MathService {
    return this.deps.math;
  }

  get logger(): Logger {
    return this.deps.logger;
  }

  async loadConfig(): Promise<RuntimeConfig> {
    try {
      return parseRuntimeConfig(await this.deps.repository.getConfig());
    } catch (error) {
      this.deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'could not read CONFIG tab; using defaults',
      );
      return parseRuntimeConfig({});
    }
  }

  /** Builds the consistent snapshot every command works from. */
  async buildContext(): Promise<AgentContext> {
    const config = await this.loadConfig();
    const zone = config.timezone;
    const now = DateTime.fromJSDate(this.deps.now(), { zone });

    const [tasks, courses] = await Promise.all([
      this.deps.repository.listTasks(),
      this.deps.repository.listCourses(),
    ]);

    const lookaheadEnd = now.plus({ days: config.calendar_lookahead_days });
    let events = await this.safeListEvents(now.startOf('day').toJSDate(), lookaheadEnd.toJSDate());

    const freeWindows = computeFreeWindows(events, zone, {
      from: now,
      to: now.endOf('day'),
      dayEnd: config.quiet_hours_start,
      minimumMinutes: 10,
    });
    const freeMinutesToday = totalFreeMinutes(freeWindows);

    const academic = computeAcademicMinimumMet(tasks, { now, zone, config });

    const stored = this.deps.state.getConversationState();
    let rescueActive = isRescueActive(stored.rescueUntil, now);

    if (!rescueActive && config.automatic_rescue_enabled) {
      const assessment = assessAutoRescue(tasks, {
        now,
        zone,
        config,
        courses,
        freeMinutesToday,
      });
      if (assessment.shouldActivate) {
        rescueActive = true;
        this.deps.state.updateConversationState({ rescueUntil: rescueExpiry(now) });
        this.deps.logger.info(
          { triggers: assessment.triggers, signals: assessment.signals },
          'auto-rescue activated',
        );
        await this.logEvent('auto_rescue', { result: assessment.triggers.join(',') });
      }
    }

    // `events` is intentionally re-used below; keep the reference stable.
    events = events.slice();

    return {
      now,
      zone,
      config,
      tasks,
      courses,
      events,
      freeWindows,
      freeMinutesToday,
      rescueActive,
      academicMinimumMet: academic.met,
      academicCompletedMinutes: academic.completedMinutes,
      academicOutstandingCount: academic.outstanding.length,
    };
  }

  private async safeListEvents(from: Date, to: Date) {
    try {
      return await this.deps.calendar.listEvents(from, to);
    } catch (error) {
      // A calendar outage must not stop the agent from working off the sheet.
      this.deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'calendar unavailable; planning without it',
      );
      return [];
    }
  }

  async logEvent(
    eventType: string,
    fields: {
      messageId?: string | null;
      command?: string | null;
      taskId?: string | null;
      result?: string | null;
      details?: string | null;
    } = {},
  ): Promise<void> {
    await this.deps.repository.appendEvent({
      timestamp: new Date(this.deps.now()).toISOString(),
      eventType,
      messageId: fields.messageId ?? null,
      command: fields.command ?? null,
      taskId: fields.taskId ?? null,
      result: fields.result ?? null,
      details: fields.details ?? null,
    });
  }

  // ---- planning ----------------------------------------------------------

  async getOrBuildPlan(context: AgentContext, options: { rebuild?: boolean } = {}) {
    const dateKey = todayKey(context);
    const existing = await this.deps.repository.getDailyPlan(dateKey);

    if (!options.rebuild && existing.length > 0) {
      const byId = new Map(context.tasks.map((task) => [task.id, task]));
      const entries = existing
        .filter((entry) => entry.status !== 'dropped')
        .map((entry) => byId.get(entry.taskId))
        .filter((task): task is Task => task !== undefined);

      // A stored plan whose tasks are all finished should be rebuilt rather
      // than shown as an empty list.
      if (entries.some(isOpen)) {
        return {
          entries,
          stored: existing,
          rescue: context.rescueActive,
          rebuilt: false,
        };
      }
    }

    const plan = buildDailyPlan(context.tasks, {
      now: context.now,
      zone: context.zone,
      config: context.config,
      courses: context.courses,
      rescueActive: context.rescueActive,
      academicMinimumMet: context.academicMinimumMet,
      freeMinutesToday: context.freeMinutesToday,
    });

    await this.deps.repository.writeDailyPlan(
      dateKey,
      plan.entries.map((entry, index) => ({
        date: dateKey,
        rank: index + 1,
        taskId: entry.task.id,
        selectedAt: context.now.toISO() ?? '',
        status: 'planned' as const,
        reason: entry.reason,
        startedAt: null,
        completedAt: null,
      })),
    );

    return {
      entries: plan.entries.map((entry) => entry.task),
      stored: await this.deps.repository.getDailyPlan(dateKey),
      rescue: plan.rescue,
      keystone: plan.keystone,
      rebuilt: true,
    };
  }

  /**
   * Picks the single best task for the time actually available right now.
   */
  async selectNow(context: AgentContext): Promise<{
    task: Task;
    availableMinutes: number;
    nextEventTitle: string | null;
    shrunkTo?: number;
    action: string;
  } | null> {
    const window = currentFreeWindow(
      context.events,
      context.zone,
      context.now,
      context.now.endOf('day'),
      context.config.quiet_hours_start,
    );
    if (!window) return null;

    const availableMinutes = windowMinutes(window);
    const { ranked } = rankTasks(context.tasks, {
      now: context.now,
      zone: context.zone,
      config: context.config,
      courses: context.courses,
      rescueActive: context.rescueActive,
      academicMinimumMet: context.academicMinimumMet,
    });

    const selection = selectForWindow(ranked, {
      availableMinutes,
      config: context.config,
    });
    if (!selection) return null;

    const upcoming = nextFixedEvent(context.events, context.zone, context.now);
    const task = selection.choice.task;

    const action =
      selection.fit.shrunkTo !== undefined
        ? shrinkAction(task, selection.fit.shrunkTo)
        : await this.resolveNextAction(task);

    return {
      task,
      availableMinutes,
      nextEventTitle: upcoming?.title ?? null,
      ...(selection.fit.shrunkTo !== undefined ? { shrunkTo: selection.fit.shrunkTo } : {}),
      action,
    };
  }

  /**
   * The concrete first action. Uses the sheet value when present, asks the
   * optional LLM only when it is missing, and always has a deterministic
   * fallback so no LLM is required.
   */
  async resolveNextAction(task: Task): Promise<string> {
    const existing = task.nextAction?.trim();
    if (existing) return existing;

    if (this.deps.ai.enabled) {
      const suggestion = await this.deps.ai.suggestNextAction({
        title: task.title,
        category: task.category,
        estimatedMinutes: task.estimatedMinutes,
        course: task.course,
        notes: task.notes,
      });
      if (suggestion) {
        // Cache it back to the sheet so it stays stable and editable.
        await this.deps.repository.updateTask(task.id, { nextAction: suggestion });
        return suggestion;
      }
    }
    return `Open ${task.title}.`;
  }

  // ---- mutations ---------------------------------------------------------

  async markCurrentTaskDone(context: AgentContext): Promise<Task | null> {
    const state = this.deps.state.getConversationState();
    let target: Task | null = state.currentTaskId
      ? (context.tasks.find((task) => task.id === state.currentTaskId) ?? null)
      : null;

    if (!target || !isOpen(target)) {
      // Fall back to today's highest-ranked open plan item.
      const plan = await this.getOrBuildPlan(context);
      target = plan.entries.find(isOpen) ?? null;
    }
    if (!target) return null;

    const completedAt = context.now.toISO();
    const updated = await this.deps.repository.updateTask(target.id, {
      status: 'completed',
      completedAt,
    });
    await this.deps.repository.updateDailyPlanEntry(todayKey(context), target.id, {
      status: 'completed',
      completedAt,
    });

    // Finishing something is meaningful progress — reset the STUCK ladder.
    this.deps.state.updateConversationState({
      currentTaskId: null,
      stuckLevel: 0,
      pendingMicroStep: null,
    });

    await this.logEvent('task_completed', { taskId: target.id, result: 'completed' });
    return updated ?? target;
  }

  async setCurrentTask(taskId: string): Promise<void> {
    this.deps.state.updateConversationState({ currentTaskId: taskId });
  }

  async snoozeTask(
    task: Task,
    until: DateTime,
  ): Promise<Task | null> {
    const updated = await this.deps.repository.updateTask(task.id, {
      status: 'snoozed',
      snoozedUntil: until.toISO(),
      avoidanceCount: task.avoidanceCount + 1,
    });
    await this.logEvent('task_snoozed', {
      taskId: task.id,
      result: until.toISO(),
    });
    return updated;
  }

  async createTask(partial: Partial<Task> & { title: string }): Promise<Task> {
    const nowIso = new Date(this.deps.now()).toISOString();
    const task: Task = {
      id: partial.id ?? `t-${randomUUID().slice(0, 8)}`,
      title: partial.title,
      category: partial.category ?? 'personal',
      course: partial.course ?? null,
      dueAt: partial.dueAt ?? null,
      estimatedMinutes: partial.estimatedMinutes ?? 30,
      importance: partial.importance ?? 3,
      difficulty: partial.difficulty ?? 3,
      courseRisk: partial.courseRisk ?? null,
      priorityOverride: partial.priorityOverride ?? null,
      status: partial.status ?? 'ready',
      nextAction: partial.nextAction ?? null,
      source: partial.source ?? 'imessage',
      calendarEventId: partial.calendarEventId ?? null,
      recurrence: partial.recurrence ?? null,
      createdAt: nowIso,
      completedAt: null,
      snoozedUntil: null,
      lastPromptedAt: null,
      avoidanceCount: 0,
      notes: partial.notes ?? null,
    };
    await this.deps.repository.createTask(task);
    await this.logEvent('task_created', { taskId: task.id, details: task.title });
    return task;
  }

  async activateRescue(context: AgentContext): Promise<void> {
    this.deps.state.updateConversationState({ rescueUntil: rescueExpiry(context.now) });
    await this.logEvent('rescue_activated', { result: 'manual' });
  }

  // ---- background maintenance -------------------------------------------

  /**
   * Imports academic deadlines that already live in the user's calendars, and
   * runs the rollover pass. Idempotent: a calendar event never produces two
   * tasks, because `calendar_event_id` is matched first.
   */
  async syncFromCalendar(context: AgentContext): Promise<{ imported: number }> {
    const detected = detectAssignments(context.events, context.courses);
    const known = new Set(
      context.tasks
        .map((task) => task.calendarEventId)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    );

    let imported = 0;
    for (const assignment of detected) {
      if (known.has(assignment.calendarEventId)) continue;
      if (assignment.dueAt <= context.now.toJSDate()) continue;

      const course = assignment.courseId
        ? context.courses.find((c) => c.courseId === assignment.courseId)
        : undefined;

      await this.createTask({
        title: assignment.title,
        category: 'academic',
        course: assignment.courseId,
        dueAt: assignment.dueAt.toISOString(),
        estimatedMinutes: assignment.estimatedMinutes,
        importance: assignment.importance,
        difficulty: assignment.kind === 'exam' ? 4 : 3,
        courseRisk: course?.riskLevel ?? null,
        source: assignment.source,
        calendarEventId: assignment.calendarEventId,
        status: 'ready',
      });
      imported += 1;
    }

    if (imported > 0) {
      this.deps.logger.info({ imported }, 'imported assignments from calendar');
    }
    return { imported };
  }

  /**
   * Applies rollover decisions for tasks that were planned yesterday and not
   * finished. Deliberately does NOT promote everything into today's list.
   */
  async runRollover(context: AgentContext): Promise<{ promoted: number; adjusted: number }> {
    const yesterday = context.now.minus({ days: 1 }).toFormat('yyyy-LL-dd');
    const previousPlan = await this.deps.repository.getDailyPlan(yesterday);
    if (previousPlan.length === 0) return { promoted: 0, adjusted: 0 };

    const missedTaskIds = new Set(
      previousPlan.filter((entry) => entry.status !== 'completed').map((entry) => entry.taskId),
    );
    if (missedTaskIds.size === 0) return { promoted: 0, adjusted: 0 };

    const decisions = evaluateRollover(context.tasks, {
      now: context.now,
      zone: context.zone,
      missedTaskIds,
    });

    let promoted = 0;
    let adjusted = 0;
    for (const decision of decisions) {
      const patch = rolloverPatch(decision);
      if (!patch) continue;
      await this.deps.repository.updateTask(decision.task.id, patch);
      if (decision.action === 'promote') promoted += 1;
      else adjusted += 1;
    }

    await this.logEvent('rollover', {
      result: `promoted=${promoted} adjusted=${adjusted}`,
    });
    this.deps.logger.info({ promoted, adjusted }, 'rollover complete');
    return { promoted, adjusted };
  }

  get studyBlockWriter(): StudyBlockWriter | null {
    return this.deps.studyBlockWriter ?? null;
  }

  get studyBlockCalendarName(): string {
    return this.deps.studyBlockCalendarName ?? 'Execution Agent';
  }

  hardDeadlineToday(context: AgentContext): boolean {
    return hardDeadlineToday(context);
  }
}
