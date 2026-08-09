# CLAUDE.md — execution-agent

Personal ADHD execution agent for one user (Zayyan). It decides what he should
do next and names the smallest action that starts it, over iMessage. Google
Sheets is the task store, calendars are read for free time, a local daemon on
his Mac is the engine.

## Load-bearing design rules (do not break these)

1. **Deterministic code owns every real decision.** Deadlines, priorities,
   task completion, calendar math, the academic lock, rescue mode, quiet
   hours — all plain tested TypeScript in `src/prioritization/` and
   `src/scheduler/`. The optional LLM layer (`src/ai/`) rewrites *wording
   only*, never decides anything, never executes anything, and the whole app
   must work with no API key configured.
2. **Academics outrank startup work by construction.** Startup tasks are
   *hidden* (not just down-ranked) until the day's academic minimum is met.
   This is the product's reason to exist — the user's GPA recovery must not
   lose to his more-fun side projects.
3. **No guilt in any message.** Never "you failed / you missed / you're
   behind / N overdue". Tests in `tests/adhdBehavior.test.ts` enforce
   phrasing. Messages stay short; the backlog is never dumped.
4. **Sheets is the source of truth; SQLite is operational state only**
   (webhook dedupe, conversation/stuck state, rate limits, caches). SQLite
   must never become a shadow task database.
5. **Messaging transports live behind `MessagingAdapter`**
   (`src/integrations/bluebubbles/types.ts`): `sendMessage`, `parseWebhook`,
   `identifyConversation`, `healthCheck`. Implement the interface; do not
   change it. Nothing outside an adapter may know transport payload shapes.
6. **Loop prevention is sacred.** Anything with `isFromMe: true` is dropped
   *before* the allowlist check, or the agent replies to itself forever.
   Consequence: same-Apple-ID self-messaging doesn't work (SETUP.md step 8).
7. **Calendars are read-only.** Writes go only to a dedicated "Execution
   Agent" calendar; writers must refuse any other calendar by name.
8. **Node 20 or 22 only** (`engines` + `.npmrc` engine-strict + `.nvmrc`).
   better-sqlite3 won't build on Node 23+. Do not "fix" install failures by
   upgrading Node.
9. **Security posture:** no eval, no shell exposure via messages, fixed
   command dispatch, handle allowlist, webhook idempotency + secret
   (constant-time compare), rate limits, secret redaction in logs
   (`src/utils/logger.ts`), no credentials committed. osascript parameters
   travel via the `EA_PARAMS` env var, never string-interpolated into script
   source.

## Commands

- `npm run simulate` — full command flow, in-memory, sends nothing. Also
  `-- --interactive`. `createSimulation()` in `src/cli/simulate.ts` is the
  test harness too.
- `npm run doctor` — every dependency checked, each failure names its fix.
- `npm run calendars` — list readable calendars by exact name.
- `npm test` / `npm run typecheck` / `npm run lint` / `npm run build`
  (build uses `tsconfig.build.json`, emits `dist/`).
- `npm run setup`, `auth:google`, `send:test`, `seed`,
  `install:launchd` / `uninstall:launchd`.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, build, and the
simulation on Node 20 + 22 for every push/PR. Keep it green.

## Architecture map

- `src/agent/agentService.ts` — orchestration core; builds one consistent
  `AgentContext` snapshot per command (`src/agent/context.ts`).
- `src/commands/` — parser (case-insensitive, tolerant), router (fixed
  dispatch table), handlers. STUCK ladder lives in `handlers.ts`
  (`microActionFor`): level 1 ≈5 min of work, 2 = get it on screen,
  3 = physical presence only; OPEN/READY climb back up; capped at 3.
- `src/prioritization/` — `score.ts` (deterministic scoring),
  `engine.ts` (eligibility: snooze, academic lock, rescue filter),
  `calendarFit.ts` (never propose a task that doesn't fit the free window,
  transition buffer, shrink-to-fit), `rescue.ts` (manual + auto thresholds),
  `rollover.ts` (missed work is evaluated, never snowballed),
  `planner.ts` (Top-3 with category balance + capacity cap).
- `src/calendar/` — `CalendarSource` interface; Google, Apple (EventKit via
  JXA in `appleCalendarScripts.ts`), ICS sources; composite merge with
  dedupe; `freeWindows.ts` (all-day events are markers not busy time);
  `assignmentDetection.ts` (only course-linked calendars import tasks);
  `studyBlocks.ts`.
- `src/sheets/` — schema (6 tabs: CONFIG, TASKS, COURSES, DAILY_PLAN,
  EVENT_LOG, MATH_MASTERY), forgiving row mapping (a typo in one cell must
  never stop the morning message), `GoogleSheetsRepository`,
  `MemoryRepository` for tests/simulation.
- `src/messaging/` — `authorization.ts` (isFromMe drop + allowlist),
  `outbound.ts` (Messenger: single choke point for quiet hours, rate limits,
  once-per-day claims, dry-run), `formatter.ts` (all user-facing wording).
- `src/scheduler/` — jobs + 5-minute tick. Morning message is claim-based
  (atomic SQLite insert), catches up after Mac sleep only before the
  `morning_catchup_cutoff`, never duplicates, never sends stale plans.
- `src/math/` — JSON bank, honest grading (`unknown` verdict → review queue,
  never falsely graded), spaced repetition.
- `src/state/` — SQLite (better-sqlite3), `StateStore`.
- `src/config/` — `env.ts` (Zod, `.env`), `runtimeConfig.ts` (CONFIG tab,
  per-field fallback on bad values, re-read every ~5 min).

Tests live in `tests/` (Vitest, 220 passing). `tests/helpers.ts` has
factories; simulation harness doubles as an end-to-end fixture.

## Environment truths

- Runtime config lives in the spreadsheet CONFIG tab, not just `.env` —
  users change behaviour without restarting.
- `CALENDAR_SOURCES=apple` is the current default (user's choice). Apple
  Calendar via EventKit sees iCloud/Exchange/Google-added-to-macOS accounts.
- Google OAuth is still required for *Sheets* even when Google Calendar is
  unused.

## Known unverified-on-macOS surface

Everything was written on Linux. These have never executed on a real Mac and
must be verified there before being trusted:

- `src/calendar/appleCalendarSource.ts` + `appleCalendarScripts.ts` (JXA/
  EventKit: list calendars, list events, ensure/create/delete agent-calendar
  events, the authorization run-loop pump).
- The launchd scripts (`scripts/launchd/`).
- Anything touching macOS permission prompts (Calendars TCC, Full Disk
  Access).
