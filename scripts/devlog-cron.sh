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

"$CLAUDE_BIN" -p "/devlog" \
  --permission-mode acceptEdits \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git shortlog:*),Bash(date:*),Bash(ls:*)" \
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
