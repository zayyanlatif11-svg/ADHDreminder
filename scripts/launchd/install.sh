#!/usr/bin/env bash
# Installs execution-agent as a macOS LaunchAgent so it starts at login and
# restarts if it crashes. Runs entirely in the user's own domain — no sudo, no
# SIP changes, nothing installed system-wide.
set -euo pipefail

LABEL="com.execution-agent.daemon"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS only. On other platforms run: npm run dev"
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Could not find node on your PATH. Install Node 20+ first (SETUP.md step 1)."
  exit 1
fi

echo "Project:  $PROJECT_DIR"
echo "Node:     $NODE_BIN"

# Build once so the agent runs compiled JS rather than depending on tsx at boot.
echo "Building..."
( cd "$PROJECT_DIR" && npm run build >/dev/null )

if [[ ! -f "$PROJECT_DIR/dist/index.js" ]]; then
  echo "Build did not produce dist/index.js. Run 'npm run build' and check the errors."
  exit 1
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"

# Unload any previous version so re-running this script is safe.
if launchctl list | grep -q "$LABEL"; then
  echo "Unloading the previous agent..."
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/dist/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <!-- Give the machine a moment after login before starting. -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/agent.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/agent.error.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>LOG_FORMAT</key>
    <string>json</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST

chmod 644 "$PLIST_PATH"

echo "Loading the agent..."
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || launchctl load "$PLIST_PATH"

sleep 2

if launchctl list | grep -q "$LABEL"; then
  echo ""
  echo "Installed and running."
  echo ""
  echo "  Status:    launchctl list | grep $LABEL"
  echo "  Logs:      tail -f $LOG_DIR/agent.log"
  echo "  Errors:    tail -f $LOG_DIR/agent.error.log"
  echo "  Health:    curl -s http://127.0.0.1:\${PORT:-4711}/health"
  echo "  Uninstall: npm run uninstall:launchd"
  echo ""
else
  echo ""
  echo "The agent was installed but is not showing as loaded."
  echo "Check $LOG_DIR/agent.error.log for the reason."
  exit 1
fi
