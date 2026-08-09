# Setup

This guide assumes you are not a programmer. Follow the steps in order.

Steps marked **MANUAL STEP** are things only you can do — clicking through
Google's website, installing an app, granting a permission. Everything else is
a command you copy and paste.

Set aside about 45 minutes for the first run. You only do this once.

**Before you start, know this:** you will need a **second iMessage address**
for a clean setup. Step 7 explains exactly why and what your options are. It is
worth reading that section before you begin so nothing surprises you.

---

## Step 1 — Install Node.js

Open **Terminal** (press `Cmd+Space`, type "Terminal", press Enter) and run:

```bash
node --version
```

You need **Node 20 or 22**. If you see `v20.` or `v22.`, skip to step 2.

> **Not any newer version.** Node 23, 24 and 25 will not work. One of this
> project's dependencies (`better-sqlite3`) ships prebuilt binaries only for the
> LTS lines, and cannot compile against newer ones — you would get several
> hundred lines of C++ compiler errors. Homebrew's plain `node` formula installs
> the newest release, so `brew install node` is the wrong command here; use
> `brew install node@22`.

**MANUAL STEP** — Otherwise, go to <https://nodejs.org> and download the
**LTS** version. Open the downloaded `.pkg` file and click through the
installer. Then **quit Terminal completely** (`Cmd+Q`) and reopen it, and check
again:

```bash
node --version
```

---

## Step 2 — Install the project

In Terminal, navigate to the project folder and install its dependencies:

```bash
cd ~/path/to/ADHDreminder
npm install
```

This takes a couple of minutes. Some warnings scrolling by are normal.

Check that it works — this needs no accounts or configuration at all:

```bash
npm run simulate
```

You should see a morning message and a walkthrough of every command. Nothing was
sent anywhere; it is all local demo data.

---

## Step 3 — Install the BlueBubbles Server

BlueBubbles is the bridge that lets a program send and receive iMessages on
your Mac.

**MANUAL STEP**

1. Go to <https://bluebubbles.app/downloads/> and download **BlueBubbles Server**
   for macOS.
2. Open the downloaded file and drag **BlueBubbles** into your Applications
   folder.
3. Open the BlueBubbles app. macOS will warn about an unidentified developer:
   go to **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway**.
4. BlueBubbles will ask for **Full Disk Access**. This is required — it needs to
   read the Messages database. Click through to System Settings and switch
   BlueBubbles on in the Full Disk Access list. You will need to restart the app.
5. When asked, let it **set a server password**. Write this down. You will need
   it in step 4.

### Leave System Integrity Protection ON

BlueBubbles offers an optional "Private API" that requires disabling System
Integrity Protection (SIP). **Do not do this.** This project deliberately uses
only the standard, supported API and works fine with SIP enabled. If you have
already disabled SIP for something else, this project still works — it just does
not need it.

---

## Step 4 — Find your BlueBubbles connection details

**MANUAL STEP**

1. In the BlueBubbles Server app, open the **Server Settings** tab.
2. Note the **port number** — it is usually `1234`. Your server URL will be
   `http://localhost:1234` (substitute your port).
3. Confirm the password you set in step 3. If you have forgotten it, you can
   reset it in that same settings screen.

Sanity check — paste this into Terminal, replacing `YOURPASSWORD`:

```bash
curl "http://localhost:1234/api/v1/ping?password=YOURPASSWORD"
```

You should see something containing `"pong"`. If you get an error, BlueBubbles
is not running or the port/password is wrong.

---

## Step 5 — Create Google credentials

This lets the agent read your calendar and your task spreadsheet. It is the
fiddliest step. Take it slowly.

**MANUAL STEP**

1. Go to <https://console.cloud.google.com/>. Sign in with the Google account
   that has your calendar.
2. At the top of the page, click the **project dropdown** (it may say "Select a
   project"), then click **New Project**.
3. Name it `execution-agent` and click **Create**. Wait for it to finish, then
   make sure it is the selected project in that same dropdown.
4. In the search bar at the top, type **Google Sheets API**, open it, and click
   **Enable**.
5. Search for **Google Calendar API**, open it, and click **Enable**.
6. In the left sidebar, go to **APIs & Services → OAuth consent screen**.
   - Choose **External**, click **Create**.
   - App name: `execution-agent`.
   - User support email: your email.
   - Developer contact email: your email.
   - Click **Save and Continue** through the Scopes and Test Users screens.
   - On the **Test users** screen, click **Add Users** and add your own Google
     email address. *This matters* — without it Google will refuse to authorize.
   - Click **Save and Continue**, then **Back to Dashboard**.
7. In the left sidebar, go to **APIs & Services → Credentials**.
8. Click **+ Create Credentials → OAuth client ID**.
9. Application type: **Desktop app**. Name: `execution-agent`. Click **Create**.
10. A dialog shows your **Client ID** and **Client Secret**. Keep this open, or
    copy both somewhere safe. You need them in step 6.

> If Google's interface has changed since this was written, the thing you are
> looking for is an **OAuth 2.0 Client ID of type "Desktop app"**, with the
> **Sheets** and **Calendar** APIs enabled on the same project.

---

## Step 6 — Run setup

```bash
npm run setup
```

This walks you through the rest and is safe to re-run at any point. Press Enter
to accept any value shown in `[brackets]`.

It will ask for:

- **Google Client ID and Secret** — from step 5.
- **Permission to open the Google consent screen.** Say yes. Your browser opens.
  Choose your Google account. You will see a warning that the app is not
  verified — click **Advanced**, then **Go to execution-agent (unsafe)**. This
  is your own app; the warning is expected. Approve both requested permissions.
- **Whether to create a spreadsheet.** Say yes. It creates one called
  "Execution Agent" with all the tabs set up, and prints the link.
- **Whether to add demo data.** Say yes for your first run so you can see it work.
- **Which calendars to use** — see step 7.
- **BlueBubbles URL and password** — from step 4.
- **Your iMessage handles** — see step 8.

---

## Step 7 — Choose your calendars

The agent can read from three places, and merges them (removing duplicates):

| Source | What it covers |
|---|---|
| `google` | Calendars in your Google account |
| `apple` | The macOS Calendar app — iCloud, Exchange, **and any Google account you added to your Mac**, plus subscribed feeds |
| `ics` | Any `.ics` feed URL or file, such as a Canvas export |

Most people want `google,apple`. Setup offers that by default on a Mac.

**MANUAL STEP (Apple Calendar only)** — the first time the agent reads your Mac
calendars, macOS shows a permission prompt. Click **OK**. If you miss it, or you
see "Calendar access not granted" later:

1. Open **System Settings → Privacy & Security → Calendars**.
2. Switch on the app you run the agent from — **Terminal** (or iTerm, or your
   editor).
3. Run `npm run doctor` again to confirm.

### Linking calendars to courses

To see the exact names of every calendar the agent can read:

```bash
npm run calendars
```

Open your spreadsheet's **COURSES** tab and fill in the `calendar_id` column
with the name of the calendar each class lives on (for example `MATH 1A`). This
is how the agent recognises assignment deadlines that Canvas already syncs into
your calendar. Without it, it deliberately imports nothing rather than turning
every calendar event into a task.

---

## Step 8 — Your iMessage identity (read this carefully)

This is the one part that genuinely needs a decision from you.

The agent has two settings:

- `AUTHORIZED_USER_HANDLE` — the address you send commands **from**.
- `TARGET_HANDLE` — the address the agent sends **to**.

### The problem with texting yourself

Every message the BlueBubbles Mac's Apple ID sends is flagged `isFromMe`. The
agent **must** ignore those messages — otherwise it would read its own output as
a new command and reply to itself forever.

So if your Mac is signed into the **same Apple ID** you text from, your own
commands also arrive flagged `isFromMe`, and there is no way to tell them apart
from the agent's output. Your commands will be ignored.

**Do not assume "just text myself" works. It generally does not.**

### Your options

**Option A — a second iMessage address (recommended).**
Add a second, free address to the Mac's Apple ID and let the *bot* use that,
while you text from your normal number:

1. On the Mac running BlueBubbles, open **Messages → Settings → iMessage**.
2. Under "You can be reached for messages at", add an email address you control
   and verify it.
3. Under "Start new conversations from", pick that email address.
4. Set `TARGET_HANDLE` to **your own phone number**, and
   `AUTHORIZED_USER_HANDLE` to **your own phone number** too — the bridge now
   sends from the email address, so its messages and yours are distinguishable.

**Option B — a separate Apple ID on the Mac.**
Sign the BlueBubbles Mac into a second Apple ID used only for the bot. Set
`TARGET_HANDLE` and `AUTHORIZED_USER_HANDLE` to your personal number. This is
the cleanest separation.

**Option C — try same-account and verify.**
Set both handles to your own number, then run through step 11. If the agent
never answers you, `npm run doctor` will flag it, and you will need option A or B.

To check where you stand at any time:

```bash
npm run doctor
```

It has a check named **iMessage identity** that warns you when the two handles
are the same.

---

## Step 9 — Check everything

```bash
npm run doctor
```

Each line shows a status and, when something is wrong, the exact fix. Work
through anything marked `✗` and re-run until nothing is failing.

---

## Step 10 — Test outbound messaging

```bash
npm run send:test
```

A test message should arrive in Messages within a few seconds. If it does not,
see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## Step 11 — Connect the inbound webhook

This is what lets you send commands *to* the agent.

**MANUAL STEP**

1. Start the agent, and leave this Terminal window open:
   ```bash
   npm run dev
   ```
   It prints the exact webhook URL to use — including your secret. Copy it. It
   looks like:
   ```
   http://localhost:4711/webhook/bluebubbles?secret=abc123...
   ```
   You can also find the secret on the `WEBHOOK_SECRET` line of your `.env` file.
2. Open the **BlueBubbles Server** app.
3. Go to the **API & Webhooks** tab.
4. Find the **Webhooks** section and click **Add Webhook** (or the `+` button).
5. Paste the URL from step 1.
6. For the event subscription, tick **New Messages**. If it offers "All Events",
   that is fine too.
7. Save.

---

## Step 12 — Test the whole loop

From your phone, text the agent's address:

```
HELP
```

You should get the command list back within a few seconds. Then try:

```
WHAT NOW
```

You should get exactly one task, sized to the free time you actually have right
now.

If nothing comes back, check the Terminal window running `npm run dev` — it logs
every inbound message and why it was accepted or rejected.

---

## Step 13 — Start automatically at login

So far the agent only runs while that Terminal window is open. To make it start
by itself whenever you log in:

```bash
npm run install:launchd
```

This builds the project and installs a macOS LaunchAgent in your own user
account. No admin password, nothing system-wide, no SIP changes.

Verify it:

```bash
launchctl list | grep execution-agent
curl -s http://127.0.0.1:4711/health
```

The health check returns JSON showing whether the scheduler is running.

---

## Step 14 — Verify the scheduler

The morning message goes out at the `morning_time` in your CONFIG tab (default
08:00). To confirm the scheduler is alive without waiting until tomorrow:

```bash
curl -s http://127.0.0.1:4711/health
```

Look at `"scheduler": true` and the `lastTick` timestamp — it updates every five
minutes.

**If your Mac is asleep at 08:00**, the message is not lost. The agent sends it
when the Mac wakes, as long as that is still before `morning_catchup_cutoff`
(default 12:00). After that it skips the day entirely rather than sending you a
stale plan in the evening. It will never send two.

Logs live in `logs/agent.log` and `logs/agent.error.log`.

---

## Step 15 — Stopping and uninstalling

**Pause it for a while:**
```bash
launchctl bootout gui/$(id -u)/com.execution-agent.daemon
```

**Start it again:**
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.execution-agent.daemon.plist
```

**Remove auto-start entirely:**
```bash
npm run uninstall:launchd
```

Your `.env`, your Google Sheet, and your local data are all left alone.

**Stop it messaging you without uninstalling anything** — set `DRY_RUN=true` in
`.env` and restart. It keeps working, it just sends nothing.

---

## Making it yours

Open your spreadsheet. The **CONFIG** tab controls behaviour, and changes are
picked up within five minutes — no restart needed.

| Setting | Default | What it does |
|---|---|---|
| `timezone` | America/Los_Angeles | Everything is scheduled in this zone |
| `morning_time` | 08:00 | When the daily message arrives |
| `top_task_count` | 3 | Maximum tasks in the morning message |
| `quiet_hours_start` / `_end` | 22:30 / 07:30 | No proactive messages in this window |
| `academic_lock_enabled` | true | Hide startup work until academics are done |
| `academic_minimum_minutes` | 30 | Academic minutes required before that unlock |
| `automatic_rescue_enabled` | true | Cut the plan automatically on overloaded days |
| `rescue_task_count` | 2 | Maximum tasks in rescue mode |
| `max_study_session_minutes` | 50 | Longest single work session |
| `minimum_math_minutes` | 10 | Daily math floor |
| `career_block_days` | tue,thu | Days that get a recruiting block |
| `study_block_calendar_enabled` | false | Write study blocks to a dedicated calendar |

The **TASKS** tab is yours to edit directly. Add rows, change deadlines, adjust
`importance` — the agent reads it fresh every time. The **COURSES** tab is where
you set `risk_level` to `red` for a class you are worried about, which pushes
its work up the priority order.

### Turning on study blocks

If you want the agent to schedule study sessions into a calendar:

1. Set `study_block_calendar_enabled` to `true` in the CONFIG tab.
2. Set `STUDY_BLOCK_TARGET` in `.env` to `google` or `apple`.
3. Restart the agent.

It creates a **separate calendar named "Execution Agent"** and writes only
there. It will never modify, move, or delete anything on your real calendars —
the code refuses to write to any calendar but its own.
