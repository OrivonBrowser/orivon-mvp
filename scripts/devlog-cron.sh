#!/usr/bin/env bash
# Sunday devlog draft: runs the /devlog compiler headless and notifies the desktop.
# Installed in the user crontab as:  47 8 * * 0  <this script>
# If the machine was off on Sunday morning, just run /devlog inside Claude Code instead.
set -u
REPO="/home/jhon/Desktop/Develop/Claude/orivon-mvp"
CLAUDE_BIN="$HOME/.local/bin/claude"
LOG="$REPO/devlog/.cron.log"

cd "$REPO" || exit 1
echo "=== $(date -Is) devlog cron run ===" >> "$LOG"

# This run is UNATTENDED with auto-approved edits, and its inputs include git
# commit messages -- attacker-controlled text once outside contributions land,
# which build-plan.md actively wants. Three containments, in order of value:
#
#   1. --settings scopes file writes to devlog/ only. /devlog writes nothing
#      else, so this costs nothing and collapses the blast radius.
#   2. No `git diff` / `git show`. The /devlog spec only uses `git log`, and
#      diff/show would pull whole file contents -- the largest untrusted-text
#      surface -- in for no benefit.
#   3. --strict-mcp-config with an empty config removes every MCP server for
#      this run. Without it, an injected instruction could reach a
#      network-capable tool, and exfiltration is a worse outcome than a
#      bad file write.
"$CLAUDE_BIN" -p "/devlog" \
  --settings "$REPO/scripts/devlog-cron-settings.json" \
  --permission-mode acceptEdits \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(git log:*),Bash(date:*),Bash(ls:*)" \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  >> "$LOG" 2>&1
status=$?

# Best-effort desktop notification (cron has no session bus by default).
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
if command -v notify-send >/dev/null 2>&1; then
  if [ "$status" -eq 0 ]; then
    notify-send "Orivon devlog" "Sunday draft ready: devlog/updates/$(date +%F).md"
  else
    notify-send "Orivon devlog" "Draft FAILED (exit $status) — run /devlog manually. See devlog/.cron.log"
  fi
fi
exit "$status"
