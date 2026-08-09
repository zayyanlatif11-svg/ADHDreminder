# execution-agent

A personal ADHD execution agent that runs on your Mac and talks to you over iMessage.

It is not a todo app. Its job is to answer one question, all day, every day:

> **What should you do next, and what is the smallest action that gets you moving?**

You enter obligations. It decides priorities. It never shows you the whole backlog.

---

## What it does

```
SATURDAY — TOP 3

1. CALC — 35 min
Calc factoring practice — 8 problems
Start: Open the worksheet and do problem #1.

2. ECON — due tomorrow
Finish Econ discussion post
Start: Open Canvas and reread the prompt.

3. CAREER — 45 min
Submit 2 finance internship applications
Start: Open the tracker spreadsheet and pick the top 2.

If you only do one thing: Calc.

Reply WHAT NOW, STUCK, DONE, SNOOZE, or RESCUE.
```

- **One message each morning.** At most three things. Never a backlog dump.
- **Academics win.** Startup work is hidden until the day's academic minimum is done.
- **It knows your schedule.** Google Calendar *and* Apple Calendar (iCloud, Exchange, subscribed feeds), plus any `.ics` feed.
- **It fits the time you actually have.** A 42-minute gap never gets a 60-minute task.
- **`STUCK` makes the task smaller**, three times over, until starting is trivial.
- **`RESCUE` cuts the day to two things** when you are underwater — automatically, if the day is genuinely overloaded.
- **Daily math remediation** aimed at the algebra gaps behind Calculus.
- **No guilt.** It never counts what you missed or tells you that you are behind.

---

## Commands

| Command | What it does |
|---|---|
| `TODAY` | Today's top tasks |
| `WHAT NOW` | **One** task, sized to your current free window |
| `DONE` | Mark the current task complete, get the next one |
| `STUCK` | Shrink the task. Again and again if needed |
| `OPEN` / `READY` | Confirm a tiny step, move to the next |
| `SNOOZE 30m` \| `2h` \| `4pm` \| `tomorrow` | Move it without losing it |
| `RESCUE` | Cut today down to two things |
| `ADD finish calc worksheet tomorrow` | Capture anything, in plain English |
| `MATH` | One practice question at a time |
| `STATUS` | What the agent currently thinks |
| `HELP` | The command list |

---

## Architecture

```
Google Sheet          ← the dashboard. Human-editable source of truth for tasks.
Google + Apple Calendar ← read-only. What your day actually looks like.
Mac daemon            ← the engine. Priority, scheduling, rescue, math.
iMessage (BlueBubbles) ← the interface.
SQLite                ← operational state ONLY. Never a shadow task list.
```

Everything runs locally on your Mac. There is no server, no hosting bill, no
Supabase/Firebase/Zapier, and no paid infrastructure. **The LLM layer is
entirely optional** — every feature works with no API key configured.

```
src/
  agent/          orchestration — one consistent snapshot per command
  ai/             optional LLM layer (wording only, never decisions)
  calendar/       Google + Apple + ICS sources, free windows, study blocks
  commands/       parsing and handlers
  config/         env (Zod) and CONFIG-tab runtime settings
  integrations/   bluebubbles/ (isolated adapter), google/ (auth)
  math/           question bank, grading, spaced repetition
  messaging/      authorization, quiet hours, formatting
  prioritization/ scoring, academic lock, rescue, rollover, planner
  scheduler/      morning job, weekly health, wake-catch-up
  sheets/         schema, row mapping, repositories
  state/          SQLite: idempotency, conversation state
```

### Two design rules worth knowing

**Deterministic code owns every decision that matters.** Deadlines, priorities,
completion, calendar maths, the academic lock, rescue mode and quiet hours are
all plain, tested TypeScript. The optional LLM can only rewrite wording. It
cannot execute anything, and it never touches state.

**BlueBubbles is quarantined.** Its API has changed across versions, so every
endpoint path and payload assumption lives in `src/integrations/bluebubbles/`.
The rest of the app only knows `sendMessage`, `parseWebhook`,
`identifyConversation`, and `healthCheck`.

---

## Setup

Read **[SETUP.md](./SETUP.md)** — it is written for someone who is not a
programmer, with numbered steps and explicit `MANUAL STEP` markers wherever a
human has to click something.

The short version:

```bash
npm install
npm run setup      # interactive; safe to re-run
npm run doctor     # tells you exactly what is still missing
npm run send:test  # proves outbound iMessage works
npm run dev        # start it
```

Then, to have it start automatically at login:

```bash
npm run install:launchd
```

---

## Try it before configuring anything

`npm run simulate` runs the entire command flow locally with demo data. No
Google account, no Mac bridge, no iMessage, nothing leaves your machine.

```bash
npm run simulate                  # scripted walkthrough
npm run simulate -- --interactive # type your own commands
```

The scripted run prints the full task ranking, so you can see academics beating
startup work rather than taking it on faith.

---

## All commands

| Command | Purpose |
|---|---|
| `npm run setup` | Interactive setup. Re-runnable |
| `npm run doctor` | Check every dependency and report the fix for each problem |
| `npm run dev` | Run locally with hot reload |
| `npm test` | Full automated test suite |
| `npm run simulate` | Exercise every command locally, sending nothing |
| `npm run send:test` | Send one harmless test iMessage |
| `npm run seed` | Write demo tasks into your sheet |
| `npm run auth:google` | Re-run Google authorization on its own |
| `npm run build` / `npm run typecheck` | Compile / typecheck |
| `npm run install:launchd` | Start automatically at login |
| `npm run uninstall:launchd` | Stop doing that |

---

## Security

Single-user by design.

- Exact allowlist on the sending handle; everything else is dropped.
- The agent ignores its own outgoing messages, so it cannot talk to itself.
- Webhook idempotency in SQLite — a redelivered event never runs twice.
- Shared secret on the webhook URL, compared in constant time.
- Secrets redacted from logs (keys, bearer tokens, URL query credentials).
- Rate limits on both inbound commands and proactive messages.
- No shell access, no `eval`, no dynamic dispatch on message text. Commands map
  to a fixed set of functions.
- Calendars are read-only. Writes are confined to a dedicated `Execution Agent`
  calendar, and the writers refuse any other calendar.
- `.env`, tokens, and `data/` are gitignored. Nothing secret is committed.

---

## Troubleshooting

See **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)**, and run `npm run doctor`
first — it diagnoses most problems and tells you the fix.
