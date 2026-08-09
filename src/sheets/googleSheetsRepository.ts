import { google, type sheets_v4 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { Logger } from '../utils/logger.js';
import type {
  Course,
  DailyPlanEntry,
  EventLogEntry,
  MathMasteryRow,
  Task,
} from '../tasks/types.js';
import type { TaskRepository } from './repository.js';
import {
  TAB,
  TAB_COLUMNS,
  columnLetter,
  type TabName,
} from './schema.js';
import {
  courseToRow,
  dailyPlanToRow,
  eventLogToRow,
  masteryToRow,
  rowToCourse,
  rowToDailyPlan,
  rowToMastery,
  rowToTask,
  taskToRow,
  type Row,
} from './rowMapping.js';
import { CONFIG_SEED_ROWS } from '../config/runtimeConfig.js';

interface CacheEntry {
  at: number;
  values: string[][];
}

export interface GoogleSheetsRepositoryOptions {
  auth: OAuth2Client;
  spreadsheetId: string;
  logger: Logger;
  /** Short cache so one command does not make a dozen identical API calls. */
  cacheMs?: number;
}

/**
 * Google Sheets implementation of TaskRepository.
 *
 * Reads are cached briefly (a single command handler often needs tasks two or
 * three times); every write invalidates the affected tab so the user never sees
 * stale data after an update.
 */
export class GoogleSheetsRepository implements TaskRepository {
  private readonly api: sheets_v4.Sheets;
  private readonly spreadsheetId: string;
  private readonly log: Logger;
  private readonly cacheMs: number;
  private readonly cache = new Map<TabName, CacheEntry>();

  constructor(options: GoogleSheetsRepositoryOptions) {
    this.api = google.sheets({ version: 'v4', auth: options.auth });
    this.spreadsheetId = options.spreadsheetId;
    this.log = options.logger.child({ module: 'sheets' });
    this.cacheMs = options.cacheMs ?? 5_000;
  }

  // ---- low level ---------------------------------------------------------

  private async readTab(tab: TabName, force = false): Promise<string[][]> {
    const cached = this.cache.get(tab);
    if (!force && cached && Date.now() - cached.at < this.cacheMs) return cached.values;

    const width = columnLetter(TAB_COLUMNS[tab].length);
    const response = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${tab}!A1:${width}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const values = (response.data.values ?? []).map((row) =>
      (row as unknown[]).map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
    );
    this.cache.set(tab, { at: Date.now(), values });
    return values;
  }

  private invalidate(tab: TabName): void {
    this.cache.delete(tab);
  }

  private async append(tab: TabName, rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows as unknown[][] },
    });
    this.invalidate(tab);
  }

  private async writeRow(tab: TabName, rowNumber: number, row: Row): Promise<void> {
    const width = columnLetter(TAB_COLUMNS[tab].length);
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${tab}!A${rowNumber}:${width}${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row as unknown[]] },
    });
    this.invalidate(tab);
  }

  // ---- structure ---------------------------------------------------------

  async ensureStructure(): Promise<void> {
    const meta = await this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const existing = new Set(
      (meta.data.sheets ?? [])
        .map((sheet) => sheet.properties?.title)
        .filter((title): title is string => typeof title === 'string'),
    );

    const missing = (Object.values(TAB) as TabName[]).filter((tab) => !existing.has(tab));
    if (missing.length > 0) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
        },
      });
      this.log.info({ tabs: missing }, 'created missing tabs');
    }

    // Header rows — write them for any tab that is empty.
    for (const tab of Object.values(TAB) as TabName[]) {
      const values = await this.readTab(tab, true);
      if (values.length === 0 || (values[0] ?? []).every((cell) => cell.trim() === '')) {
        await this.writeRow(tab, 1, [...TAB_COLUMNS[tab]]);
        this.log.info({ tab }, 'wrote header row');
      }
    }

    // Seed CONFIG defaults only for keys the user has not already set.
    const config = await this.getConfig();
    const missingConfig = CONFIG_SEED_ROWS.filter(([key]) => !(key in config));
    if (missingConfig.length > 0) {
      await this.append(TAB.CONFIG, missingConfig.map((r) => [...r]));
      this.log.info({ count: missingConfig.length }, 'seeded CONFIG defaults');
    }
  }

  // ---- CONFIG ------------------------------------------------------------

  async getConfig(): Promise<Record<string, string>> {
    const values = await this.readTab(TAB.CONFIG);
    const out: Record<string, string> = {};
    for (const row of values.slice(1)) {
      const key = (row[0] ?? '').trim();
      if (key === '') continue;
      out[key.toLowerCase()] = (row[1] ?? '').trim();
    }
    return out;
  }

  async setConfigValue(key: string, value: string): Promise<void> {
    const values = await this.readTab(TAB.CONFIG, true);
    const index = values.findIndex(
      (row, i) => i > 0 && (row[0] ?? '').trim().toLowerCase() === key.toLowerCase(),
    );
    if (index === -1) {
      await this.append(TAB.CONFIG, [[key, value, '']]);
      return;
    }
    const existing = values[index] ?? [];
    await this.writeRow(TAB.CONFIG, index + 1, [key, value, existing[2] ?? '']);
  }

  // ---- TASKS -------------------------------------------------------------

  async listTasks(): Promise<Task[]> {
    const values = await this.readTab(TAB.TASKS);
    if (values.length === 0) return [];
    const headers = values[0] ?? [];
    const tasks: Task[] = [];
    for (let i = 1; i < values.length; i += 1) {
      const parsed = rowToTask(values[i] ?? [], headers, i + 1);
      if (parsed) tasks.push(parsed);
    }
    return tasks;
  }

  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.listTasks();
    return tasks.find((t) => t.id === id) ?? null;
  }

  async createTask(task: Task): Promise<Task> {
    await this.append(TAB.TASKS, [taskToRow(task)]);
    return task;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
    const tasks = await this.listTasks();
    const existing = tasks.find((t) => t.id === id);
    if (!existing?.rowNumber) return null;
    const next: Task = { ...existing, ...patch, id: existing.id };
    await this.writeRow(TAB.TASKS, existing.rowNumber, taskToRow(next));
    return next;
  }

  // ---- COURSES -----------------------------------------------------------

  async listCourses(): Promise<Course[]> {
    const values = await this.readTab(TAB.COURSES);
    if (values.length === 0) return [];
    const headers = values[0] ?? [];
    const courses: Course[] = [];
    for (let i = 1; i < values.length; i += 1) {
      const parsed = rowToCourse(values[i] ?? [], headers, i + 1);
      if (parsed) courses.push(parsed);
    }
    return courses;
  }

  async upsertCourse(course: Course): Promise<void> {
    const courses = await this.listCourses();
    const existing = courses.find((c) => c.courseId === course.courseId);
    if (existing?.rowNumber) await this.writeRow(TAB.COURSES, existing.rowNumber, courseToRow(course));
    else await this.append(TAB.COURSES, [courseToRow(course)]);
  }

  // ---- DAILY_PLAN --------------------------------------------------------

  async getDailyPlan(date: string): Promise<DailyPlanEntry[]> {
    const values = await this.readTab(TAB.DAILY_PLAN);
    if (values.length === 0) return [];
    const headers = values[0] ?? [];
    const entries: DailyPlanEntry[] = [];
    for (let i = 1; i < values.length; i += 1) {
      const parsed = rowToDailyPlan(values[i] ?? [], headers, i + 1);
      if (parsed && parsed.date === date) entries.push(parsed);
    }
    return entries.sort((a, b) => a.rank - b.rank);
  }

  /**
   * Replaces today's plan by marking existing rows dropped and appending the
   * new ones. Rows are never deleted, so the sheet stays a readable history.
   */
  async writeDailyPlan(date: string, entries: DailyPlanEntry[]): Promise<void> {
    const existing = await this.getDailyPlan(date);
    const keepIds = new Set(entries.map((e) => e.taskId));
    for (const entry of existing) {
      if (!keepIds.has(entry.taskId) && entry.status === 'planned' && entry.rowNumber) {
        await this.writeRow(
          TAB.DAILY_PLAN,
          entry.rowNumber,
          dailyPlanToRow({ ...entry, status: 'dropped' }),
        );
      }
    }
    const existingIds = new Set(existing.map((e) => e.taskId));
    const fresh = entries.filter((e) => !existingIds.has(e.taskId));
    await this.append(TAB.DAILY_PLAN, fresh.map(dailyPlanToRow));
  }

  async updateDailyPlanEntry(
    date: string,
    taskId: string,
    patch: Partial<DailyPlanEntry>,
  ): Promise<void> {
    const entries = await this.getDailyPlan(date);
    const target = entries.find((e) => e.taskId === taskId);
    if (!target?.rowNumber) return;
    await this.writeRow(TAB.DAILY_PLAN, target.rowNumber, dailyPlanToRow({ ...target, ...patch }));
  }

  // ---- EVENT_LOG ---------------------------------------------------------

  async appendEvent(entry: EventLogEntry): Promise<void> {
    // The log is best-effort telemetry: a failure here must never break a command.
    try {
      await this.append(TAB.EVENT_LOG, [eventLogToRow(entry)]);
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'failed to append event log row',
      );
    }
  }

  // ---- MATH_MASTERY ------------------------------------------------------

  async listMastery(): Promise<MathMasteryRow[]> {
    const values = await this.readTab(TAB.MATH_MASTERY);
    if (values.length === 0) return [];
    const headers = values[0] ?? [];
    const rows: MathMasteryRow[] = [];
    for (let i = 1; i < values.length; i += 1) {
      const parsed = rowToMastery(values[i] ?? [], headers, i + 1);
      if (parsed) rows.push(parsed);
    }
    return rows;
  }

  async upsertMastery(row: MathMasteryRow): Promise<void> {
    const rows = await this.listMastery();
    const existing = rows.find((r) => r.concept === row.concept);
    if (existing?.rowNumber) await this.writeRow(TAB.MATH_MASTERY, existing.rowNumber, masteryToRow(row));
    else await this.append(TAB.MATH_MASTERY, [masteryToRow(row)]);
  }
}
