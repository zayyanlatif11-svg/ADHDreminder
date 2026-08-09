import type {
  Course,
  DailyPlanEntry,
  EventLogEntry,
  MathMasteryRow,
  Task,
} from '../tasks/types.js';
import type { TaskRepository } from './repository.js';

/**
 * In-memory TaskRepository for tests and `npm run simulate`.
 *
 * Deliberately mirrors the Sheets semantics that matter: tasks are matched by
 * id, updates are partial merges, and the event log is append-only.
 */
export class MemoryRepository implements TaskRepository {
  config: Record<string, string> = {};
  tasks: Task[] = [];
  courses: Course[] = [];
  plans = new Map<string, DailyPlanEntry[]>();
  events: EventLogEntry[] = [];
  mastery: MathMasteryRow[] = [];

  constructor(seed?: {
    config?: Record<string, string>;
    tasks?: Task[];
    courses?: Course[];
    mastery?: MathMasteryRow[];
  }) {
    if (seed?.config) this.config = { ...seed.config };
    if (seed?.tasks) this.tasks = seed.tasks.map((t) => ({ ...t }));
    if (seed?.courses) this.courses = seed.courses.map((c) => ({ ...c }));
    if (seed?.mastery) this.mastery = seed.mastery.map((m) => ({ ...m }));
  }

  async ensureStructure(): Promise<void> {
    // Nothing to create in memory.
  }

  async getConfig(): Promise<Record<string, string>> {
    return { ...this.config };
  }

  async setConfigValue(key: string, value: string): Promise<void> {
    this.config[key] = value;
  }

  async listTasks(): Promise<Task[]> {
    return this.tasks.map((t) => ({ ...t }));
  }

  async getTask(id: string): Promise<Task | null> {
    const found = this.tasks.find((t) => t.id === id);
    return found ? { ...found } : null;
  }

  async createTask(task: Task): Promise<Task> {
    this.tasks.push({ ...task });
    return { ...task };
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return null;
    const current = this.tasks[index];
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id };
    this.tasks[index] = next;
    return { ...next };
  }

  async listCourses(): Promise<Course[]> {
    return this.courses.map((c) => ({ ...c }));
  }

  async upsertCourse(course: Course): Promise<void> {
    const index = this.courses.findIndex((c) => c.courseId === course.courseId);
    if (index === -1) this.courses.push({ ...course });
    else this.courses[index] = { ...course };
  }

  async getDailyPlan(date: string): Promise<DailyPlanEntry[]> {
    return (this.plans.get(date) ?? []).map((e) => ({ ...e }));
  }

  async writeDailyPlan(date: string, entries: DailyPlanEntry[]): Promise<void> {
    this.plans.set(
      date,
      entries.map((e) => ({ ...e })),
    );
  }

  async updateDailyPlanEntry(
    date: string,
    taskId: string,
    patch: Partial<DailyPlanEntry>,
  ): Promise<void> {
    const entries = this.plans.get(date);
    if (!entries) return;
    const index = entries.findIndex((e) => e.taskId === taskId);
    if (index === -1) return;
    const current = entries[index];
    if (!current) return;
    entries[index] = { ...current, ...patch };
  }

  async appendEvent(entry: EventLogEntry): Promise<void> {
    this.events.push({ ...entry });
  }

  async listMastery(): Promise<MathMasteryRow[]> {
    return this.mastery.map((m) => ({ ...m }));
  }

  async upsertMastery(row: MathMasteryRow): Promise<void> {
    const index = this.mastery.findIndex((m) => m.concept === row.concept);
    if (index === -1) this.mastery.push({ ...row });
    else this.mastery[index] = { ...row };
  }
}
