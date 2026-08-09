# Troubleshooting

**Start here:**

```bash
npm run doctor
```

It checks every dependency and prints the specific fix for anything broken. Most
problems below are things `doctor` will already have told you.

---

## Nothing happens when I text the agent

This is the most common problem, and it has a short list of causes. Work down it.

### 1. Is the agent actually running?

```bash
curl -s http://127.0.0.1:4711/health
```

Expected: JSON with `"ok": true`. If you get "Connection refused", it is not
running. Start it with `npm run dev`, or check `logs/agent.error.log` if you
installed it with launchd.

### 2. Is the webhook configured in BlueBubbles?

Open the BlueBubbles Server app → **API & Webhooks** → Webhooks. There should be
an entry pointing at:

```
http://localhost:4711/webhook/bluebubbles?secret=YOUR_SECRET
```

The secret must match `WEBHOOK_SECRET` in your `.env` exactly. A missing or
wrong secret gets a `401` and the message is dropped. Make sure the webhook is
subscribed to **New Messages**.

### 3. Is your message being ignored on purpose?

Watch the log while you text:

```bash
npm run dev
```

Then send a message. You will see one of these:

| Log message | What it means | Fix |
|---|---|---|
| `inbound message rejected` with `unauthorized_handle` | The sender is not on the allowlist | Set `AUTHORIZED_USER_HANDLE` in `.env` to the address you text from |
| Nothing logged at all | The message never arrived | The webhook is not configured — see 2 above |
| `duplicate webhook ignored` | Already handled | Normal, not a problem |
| No rejection but no reply | Almost always the identity problem below | See next section |

---

## The agent ignores my messages but sends fine

This is the **self-messaging trap**, and it is expected behaviour rather than a bug.

Every message sent by the Mac's Apple ID is flagged `isFromMe`. The agent must
ignore those, or it would read its own output as a command and reply to itself
in an infinite loop.

If your Mac is signed into the same Apple ID you text from, **your** messages are
also flagged `isFromMe` — and there is no way to distinguish them from the
agent's own output.

Confirm it:

```bash
npm run doctor
```

Look for the **iMessage identity** check. If it warns that both handles are the
same, you have hit this.

**The fix** is to give the bridge its own address. [SETUP.md step 8](./SETUP.md)
covers three options in detail; the quickest is:

1. On the Mac running BlueBubbles: **Messages → Settings → iMessage**.
2. Add an email address under "You can be reached for messages at" and verify it.
3. Set "Start new conversations from" to that email address.
4. Now the agent sends from the email, you text from your number, and the two are
   distinguishable.

---

## Google problems

### "Google is not authorized yet"

```bash
npm run auth:google
```

### "Access blocked: execution-agent has not completed the Google verification process"

Your own Google account is not on the test-user list. Go to
<https://console.cloud.google.com/> → **APIs & Services → OAuth consent screen**
→ **Test users** → **Add Users**, and add your own email. Then re-run
`npm run auth:google`.

### "This app isn't verified"

Expected — it is your own private app. Click **Advanced**, then
**Go to execution-agent (unsafe)**.

### Google did not return a refresh token

This happens if you have authorized before. Revoke it and start clean:

1. Go to <https://myaccount.google.com/permissions>.
2. Find `execution-agent` and remove its access.
3. Delete the stored token: `rm secrets/google-token.json`
4. `npm run auth:google`

### "The caller does not have permission" on the spreadsheet

`SPREADSHEET_ID` in `.env` points at a sheet your authorized account cannot open.
Check the ID — it is the long string in the sheet's URL between `/d/` and `/edit`.
Or let setup make a fresh one: clear `SPREADSHEET_ID` and run `npm run setup`.

### Tabs or columns are missing

```bash
npm run setup
```

It recreates any missing tab and header row without touching your existing rows.

---

## Calendar problems

### Apple Calendar: "Calendar access not granted"

macOS is blocking it.

1. **System Settings → Privacy & Security → Calendars**.
2. Switch on the app you run the agent from — **Terminal**, iTerm, or your editor.
3. Re-run `npm run doctor`.

If the toggle is missing entirely, the prompt was never triggered. Force it:

```bash
osascript -l JavaScript -e 'ObjC.import("EventKit"); $.EKEventStore.alloc.init.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, function(){}); "done"'
```

If you run the agent under launchd and calendar reads work manually but not
automatically, grant Calendar access to `/usr/local/bin/node` (or wherever
`which node` points) as well.

### Apple Calendar returns nothing

- `APPLE_CALENDAR_NAMES` may list a calendar name that does not exist. Names must
  match exactly, including case. Leave it blank to read everything.
- Check what the agent can actually see: `npm run doctor` reports the calendar
  count per source.

### My schedule looks twice as busy as it is

You are reading the same calendar through two sources — typically a Google
account that is also added to your Mac. The agent de-duplicates events with the
same title and time, but if they differ slightly (a renamed calendar, a shifted
minute) both survive. Drop one source from `CALENDAR_SOURCES` in `.env`.

### Assignments in my calendar are not becoming tasks

Deliberate. The agent only imports assignment-shaped events from calendars linked
to a course, because importing every calendar event would flood your backlog.

Open the **COURSES** tab and set `calendar_id` to the exact calendar name each
class lives on. The title also has to look like coursework — "Homework 4 due",
"Midterm Exam", "Essay due" all match; "MATH 1A Lecture" and "Office Hours" are
excluded on purpose.

### Recurring events from an ICS feed are missing

The ICS reader does not expand `RRULE`, because inventing occurrences is worse
than omitting them. Get recurring classes from Google or Apple Calendar instead —
both expand recurrence correctly.

---

## BlueBubbles problems

### "BlueBubbles is not reachable"

1. Is the app running? Look for it in the menu bar.
2. Is the port right? BlueBubbles Server → **Server Settings** → port (usually
   `1234`). Match it in `BLUEBUBBLES_SERVER_URL`.
3. Test directly:
   ```bash
   curl "http://localhost:1234/api/v1/ping?password=YOURPASSWORD"
   ```
   Expect `"pong"`. A `401` means the password is wrong.

### Messages fail to send

- Open **Messages.app** on the Mac and confirm you are signed into iMessage.
- Send a message to the target address manually from Messages. If that fails,
  it is an iMessage problem, not an agent problem.
- Confirm BlueBubbles still has **Full Disk Access** in System Settings.
- If `TARGET_HANDLE` has never been texted from this Mac, try setting `CHAT_GUID`
  instead. `npm run send:test` prints the GUID of an existing 1:1 chat if it
  finds one.

### Endpoints return 404

BlueBubbles has changed its API across versions. Every path lives in one file:
`src/integrations/bluebubbles/client.ts`, in the `ROUTES` constant at the top.
Compare it against your server's version at
<https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks> and
edit there — nothing else in the codebase depends on those paths.

---

## Scheduling problems

### No morning message arrived

1. Was it already sent? `npm run doctor` reports today's status. It sends once
   per day by design.
2. Was your Mac asleep? It catches up on wake, but only before
   `morning_catchup_cutoff` (default 12:00). After that it skips the day rather
   than sending a stale plan.
3. Was it quiet hours? Proactive messages are suppressed between
   `quiet_hours_start` and `quiet_hours_end`. Your own commands still get replies.
4. Is the scheduler alive? `curl -s http://127.0.0.1:4711/health` — check
   `"scheduler": true` and a recent `lastTick`.

### I got the same message twice

This should not happen — the daily claim is an atomic SQLite insert. If it did,
you are probably running two copies. Check:

```bash
launchctl list | grep execution-agent
ps aux | grep "dist/index.js"
```

Stop the manual `npm run dev` if the launchd copy is also running.

### Force a morning message for testing

```bash
npm run simulate
```

Shows exactly what would be sent, without sending it.

---

## Behaviour that looks wrong but is not

**"It only showed me one task."** — Rescue mode is on, or that is genuinely all
that fits your free time today. `STATUS` tells you which.

**"It won't show me my startup work."** — The academic lock. Finish the day's
academic minimum and it unlocks; you will get an explicit "Startup is unlocked"
message. To turn it off, set `academic_lock_enabled` to `false` in CONFIG.

**"It ignored a task I care about."** — Check the **TASKS** tab: it may be
`snoozed` with a future `snoozed_until`, or `cancelled` by the rollover pass. Raise
`importance`, or set `priority_override` to a positive number to force it up.

**"It says I have less free time than I do."** — Something on your calendar is
marked busy. All-day events do not count as busy, and neither do events you are
marked "free" for, but a long "Work" block does.

**"It's not giving me math questions."** — `MATH` gives one question at a time by
design. Answer it and the next one arrives.

**"It marked my math answer as ungraded."** — It could not confidently parse your
answer, so it refused to guess. Those are logged for review rather than marked
wrong. Reply with just the number.

---

## Resetting things

**Clear local operational state** (dedupe records, stuck level, rescue flag).
Your tasks are in Google Sheets and are untouched:

```bash
rm -rf data/
```

**Re-authorize Google:**

```bash
rm secrets/google-token.json && npm run auth:google
```

**Start over completely** (keeps your spreadsheet):

```bash
rm -rf data/ secrets/ .env
npm run setup
```

---

## Getting more detail

Run with debug logging:

```bash
LOG_LEVEL=debug npm run dev
```

Logs redact secrets automatically — API keys, bearer tokens, and passwords in
URLs are stripped before anything is written. It is safe to share a log excerpt.

Under launchd, logs are in `logs/agent.log` and `logs/agent.error.log`.

Your spreadsheet's **EVENT_LOG** tab also records every command, decision, and
result, which is often the fastest way to see what the agent thought it was doing.
