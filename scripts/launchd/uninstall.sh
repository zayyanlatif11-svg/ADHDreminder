#!/usr/bin/env bash
# Removes the execution-agent LaunchAgent. Your .env, spreadsheet, and local
# database are left untouched.
set -euo pipefail

LABEL="com.execution-agent.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This uninstaller is for macOS only."
  exit 1
fi

if launchctl list | grep -q "$LABEL"; then
  echo "Stopping the agent..."
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
else
  echo "The agent is not currently loaded."
fi

if [[ -f "$PLIST_PATH" ]]; then
  rm -f "$PLIST_PATH"
  echo "Removed $PLIST_PATH"
else
  echo "No plist found at $PLIST_PATH"
fi

echo ""
echo "Uninstalled. Your .env, Google Sheet, and local data/ are untouched."
echo "To run it manually again: npm run dev"
echo ""
