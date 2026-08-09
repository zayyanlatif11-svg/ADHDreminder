# HANDOFF — from the cloud session that built this project

Written 2026-08-09 for the local (desktop app) session taking over on
Zayyan's MacBook Pro. Read `CLAUDE.md` first for architecture and rules;
this file is the state transfer and the task brief. Delete it once the work
below is done.

## Where things stand

All work so far is merged to `main` (three squash-merged PRs):

- `76fb8e7` (#1) — the entire project: priority engine, academic lock,
  rescue, rollover, STUCK ladder, math module, Sheets/Calendar/BlueBubbles
  adapters, scheduler, HTTP webhook server, CLI tooling, launchd scripts,
  docs (README / SETUP / TROUBLESHOOTING), 217 tests, CI.
- `dd55ac3` (#2) — Node pinned to 20/22 with engine-strict + .nvmrc, after
  a real install failure on the user's machine (Homebrew Node 25 cannot
  build better-sqlite3). User has since installed node@22 via Homebrew and
  put it first on PATH; `node --version` on his machine prints v22.23.2.
- `f5e5ce4` (#3) — DONE-reply wording fix: unlocking startup via the daily
  minute-minimum no longer claims "Academic must-dos are done." while an
  academic task is still due; says "That's today's academic minimum."
  instead. Found by the user in real simulate output.

Verified state: 220 tests passing, typecheck/lint/build clean, CI green on
Node 20 + 22, `npm run simulate` runs end-to-end on the user's Mac.

## What the user has done so far

- Cloned the repo to `~/ADHDreminder`, fixed Node, ran the simulation
  successfully and read the output critically (he caught the #3 bug).
- Chosen **Apple Calendar only** for now (`CALENDAR_SOURCES=apple` is the
  committed default in `.env.example`).
- **No real setup yet**: no `.env`, no Google OAuth, no BlueBubbles, no
  webhook, no launchd. He has not created the spreadsheet.

## Why you exist: the primary task

The user asked whether BlueBubbles has malware. Honest answer given: it's
open source (Apache 2.0) with no credible malware reports, but it is
**unsigned/un-notarized** (Apple has never scanned it), requires Full Disk
Access, macOS shows a malware-style Gatekeeper warning, and Homebrew has
deprecated the cask with a **disable date of 2026-09-01**
(bluebubbles-server issue #790, unresolved). He would rather not trust the
third-party binary.

### Build a native macOS messaging adapter

Add a second messaging backend so no third-party binary is needed:

- **Selection:** `MESSAGING_BACKEND=native | bluebubbles` in `.env`
  (wire through `src/config/env.ts` and the composition root `src/app.ts`).
  Keep the BlueBubbles adapter fully working — one-line fallback.
- **Interface:** implement `MessagingAdapter` from
  `src/integrations/bluebubbles/types.ts` exactly. Do not modify it.
  Suggested location: `src/integrations/nativemac/`.
- **Send:** `osascript` → Messages.app. Follow the pattern in
  `src/calendar/appleCalendarSource.ts`: `execFile` (never a shell string),
  parameters via the `EA_PARAMS` env var, never interpolated into script
  source.
- **Receive:** poll `~/Library/Messages/chat.db` **read-only** with a
  ROWID cursor persisted in `StateStore` (`kv` table). better-sqlite3 is
  already a dependency — open with `{ readonly: true, fileMustExist: true }`.
  A monotonic cursor gives idempotency for free; a restart resumes from the
  last ROWID.
- **Loop prevention carries over:** `message.is_from_me` in chat.db is the
  same signal as the webhook's `isFromMe`. Map it faithfully; the existing
  authorization tests describe the invariant.
- **The hard part — `attributedBody`:** on modern macOS `message.text` is
  often NULL and the content lives in `attributedBody` as a typedstream/
  NSArchiver blob. Extract the text heuristically; when extraction fails,
  return empty text and log — never guess. **Test the parser against the
  user's real chat.db**; synthetic fixtures are not sufficient. Also handle
  Apple's nanosecond-epoch `date` fields (seconds since 2001-01-01 ×1e9 in
  newer schemas).
- **Polling cadence:** ~2–3 s while awake; the poller must survive chat.db
  being locked (Messages writes constantly — busy_timeout / retry).
- **healthCheck:** chat.db openable? Full Disk Access granted? (An
  unreadable chat.db in the sandboxed path is the FDA-missing signature —
  return a message pointing at System Settings → Privacy & Security → Full
  Disk Access for the terminal/app hosting the agent.)
- **Docs/tooling:** update SETUP.md (native path needs FDA for *your own
  process*, no third-party app; BlueBubbles becomes the alternative path),
  TROUBLESHOOTING.md, `.env.example`, and add a `doctor` check that names
  the active backend and whether its permissions are actually granted.
- **Tests:** adapter-level tests with a fixture chat.db you construct +
  whatever real-blob parsing tests you can derive on the Mac. Keep CI green
  — CI is Linux, so the macOS-only paths must skip cleanly there (follow the
  `requiresMacOs` pattern in `appleCalendarSource.ts`, which exists exactly
  so injected fakes remain testable off-Mac).

### Secondary task: verify the never-run-on-macOS code

You are the first session with real macOS access. Verify (and fix in place):

1. `npm run calendars` and `npm run doctor` against real Calendar.app —
   the JXA/EventKit scripts have never executed anywhere.
2. The Calendars TCC prompt flow (and document which app gets the grant).
3. Later, when the user opts in: launchd install/uninstall, and note that
   the plist bakes in the node path resolved at install time (his PATH puts
   node@22 first, so that's correct today).

### Things the cloud session could not do (told to user, still true)

- Real-device verification of anything Apple-specific (reason you exist).
- npm audit status: the critical/high findings are vitest/vite (dev-only);
  production-tree findings are moderate, via a transitive `uuid` in
  googleapis/node-cron. Deliberately not force-fixed; don't churn the
  lockfile without cause.

## Open decision the user has NOT made (do not decide for him)

Whether startup work should unlock while an academic task is still due
within 48h. Today: `academic_minimum_minutes` (30, CONFIG tab) alone opens
the gate. Options offered: raise the number (no code), or require both the
minutes AND no imminent academic deadline (code). He hasn't chosen. Ask if
it becomes relevant; don't change the behaviour unprompted.

## After the native adapter, his remaining setup path

1. `npm run setup` (creates `.env`, Google OAuth, spreadsheet + tabs, seeds
   demo data). Google Cloud gotcha: he must add his own email as an OAuth
   **Test user** or Google refuses authorization.
2. iMessage identity (SETUP.md step 8): with the native adapter this
   constraint is *unchanged* — his own sends are `is_from_me=1`, so a second
   iMessage-capable address for the bot side is still the clean setup.
3. `npm run doctor` → `npm run send:test` → command round-trip → launchd.

## Working conventions this repo has used

- Conventional, explanatory commit messages (why, not just what);
  Claude-attribution footers on commits/PRs.
- PRs created as drafts, merged after CI green on both Node versions;
  squash merges.
- Bugs found by tests or by the user get fixed at the cause and pinned with
  a regression test that quotes the observed failure.
