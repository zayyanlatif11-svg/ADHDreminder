import type {
  Course,
  DailyPlanEntry,
  EventLogEntry,
  MathMasteryRow,
  Task,
} from '../tasks/types.js';

/**
 * Storage contract for the human-editable source of truth.
 *
 * The application depends on this interface, never on the Google client, so
 * tests and simulation can run against an in-memory implementation.
 */
export interface TaskRepository {
  getConfig(): Promise<Record<string, string>>;
  setConfigValue(key: string, value: string): Promise<void>;

  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(task: Task): Promise<Task>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task | null>;

  listCourses(): Promise<Course[]>;
  upsertCourse(course: Course): Promise<void>;

  getDailyPlan(date: string): Promise<DailyPlanEntry[]>;
  writeDailyPlan(date: string, entries: DailyPlanEntry[]): Promise<void>;
  updateDailyPlanEntry(
    date: string,
    taskId: string,
    patch: Partial<DailyPlanEntry>,
  ): Promise<void>;

  appendEvent(entry: EventLogEntry): Promise<void>;

  listMastery(): Promise<MathMasteryRow[]>;
  upsertMastery(row: MathMasteryRow): Promise<void>;

  /** Creates missing tabs/headers. Safe to call repeatedly. */
  ensureStructure(): Promise<void>;
}
