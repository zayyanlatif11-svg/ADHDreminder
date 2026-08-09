import { stdout } from 'node:process';
import { DateTime } from 'luxon';
import { buildApp } from '../app.js';
import { silentLogger } from '../utils/logger.js';
import { seedCourses, seedMastery, seedTasks } from './seedData.js';

/**
 * `npm run seed` — writes the demo courses/tasks into the configured
 * spreadsheet. Refuses to run if tasks already exist, so it cannot clobber
 * real data.
 */
async function main(): Promise<void> {
  const app = await buildApp({ logger: silentLogger });
  try {
    await app.repository.ensureStructure();
    const existing = await app.repository.listTasks();
    const force = process.argv.includes('--force');

    if (existing.length > 0 && !force) {
      stdout.write(
        `\nThe sheet already has ${existing.length} task rows. Not seeding.\nRe-run with --force if you really want to add demo rows anyway.\n\n`,
      );
      return;
    }

    const config = await app.agent.loadConfig();
    const now = DateTime.now().setZone(config.timezone);

    for (const course of seedCourses()) await app.repository.upsertCourse(course);
    for (const task of seedTasks(now)) await app.repository.createTask(task);
    for (const row of seedMastery()) await app.repository.upsertMastery(row);

    stdout.write('\nSeeded demo courses, tasks, and math mastery rows.\nNext: npm run simulate\n\n');
  } finally {
    app.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
