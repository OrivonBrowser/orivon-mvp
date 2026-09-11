#!/usr/bin/env bash
# Sunday devlog draft: gathers this period's git log itself, then runs the
# devlog compiler headless against the pre-gathered files, and notifies the
# desktop. Installed in the user crontab as:  47 8 * * 0  <this script>
#
# NOT EQUIVALENT: "just run /devlog inside Claude Code" if the machine was
# off on Sunday. That runs in the owner's own attended session, under the
# owner's ambient permissions, with none of the containments below -- an
# accepted different trust model (a human is present to notice a runaway
# edit), not an oversight. See R-S5-01.
set -u
REPO="/home/jhon/Desktop/Develop/Claude/orivon-mvp"
CLAUDE_BIN="$HOME/.local/bin/claude"
LOG="$REPO/devlog/.cron.log"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

cd "$REPO" || exit 1
echo "=== $(date -Is) devlog cron run ===" >> "$LOG"

# This run is UNATTENDED with auto-approved edits, and its inputs include git
# commit messages -- attacker-controlled text once outside contributions land,
# which build-plan.md actively wants. Containments, in order of value:
#
#   1. Edit/Write are granted ONLY for ./devlog/**, and --permission-mode
#      acceptEdits is deliberately NOT used. This is an allow-list, not a
#      deny-list, and the distinction is not academic: the first version of
#      this fix used acceptEdits plus unscoped "Write,Edit", which auto-
#      approved edits at ANY path. A test write to $HOME succeeded. Deny rules
#      could not have caught that, because they enumerate repo paths and the
#      escape was outside the repo entirely.
#   2. THE AGENT GETS NO Bash GRANT AT ALL (R-S5-01 fix, 2026-09-11). The
#      previous version granted `Bash(git log:*)`, reasoning that excluding
#      `git diff`/`git show` was enough -- but `git log`, `git diff` and
#      `git show` all accept `--output=<file>`, an arbitrary-path write with
#      attacker-chosen content (`--format='format:%B'` makes the body of a
#      malicious commit message the payload), unrelated to the Edit/Write
#      sandbox above. A fixed-argument wrapper the agent calls instead of raw
#      git was considered and rejected: it still shells out to git on the
#      agent's say-so, so it is one overlooked flag away from the same hole.
#      Instead, THIS SCRIPT runs `git log` itself, with fixed arguments the
#      agent never sees or constructs, and hands the result to the agent as
#      files to Read. An agent cannot type a command line it is never asked
#      to type.
#   3. --strict-mcp-config with an empty config removes every MCP server for
#      this run. Without it, an injected instruction could reach a
#      network-capable tool, and exfiltration is a worse outcome than a bad
#      file write.
#
# Verified 2026-09-11: the gathering commands below were run for real against
# this repo and produce the expected commits.txt / docs-changes.txt; the full
# agent invocation was not re-run live for this change (unattended writes are
# hard to safely dry-run) -- see the S6 fix log for exactly what was and was
# not exercised.
LATEST_UPDATE=$(ls -1 devlog/updates/*.md 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.md$//' | sort | tail -n1)
if [ -n "$LATEST_UPDATE" ]; then
  PERIOD_START=$(date -d "$LATEST_UPDATE +1 day" +%F)
else
  PERIOD_START=$(date -d '7 days ago' +%F)
fi
TODAY=$(date +%F)

if ! git log --since="$PERIOD_START" --date=short --pretty='%ad %h %s' \
    > "$SCRATCH/commits.txt" 2>>"$LOG"; then
  echo "devlog-cron: pre-gathering git log failed, aborting" >> "$LOG"
  exit 1
fi
# --stat only (never diff/show): filenames and line counts, not file bodies.
git log --since="$PERIOD_START" --stat --date=short --pretty='%h %ad %s' \
  -- docs/decisions docs/open-questions.md \
  > "$SCRATCH/docs-changes.txt" 2>>"$LOG"

PROMPT="Compile the weekly Sunday devlog. Follow every rule in .claude/commands/devlog.md (Read it in full) with one substitution: the period is $PERIOD_START (exclusive) to $TODAY, already decided, and its material is already gathered -- do NOT run git yourself, there is no git tool available this run. Read $SCRATCH/commits.txt for step 2's commit log, and $SCRATCH/docs-changes.txt for its docs/decisions and docs/open-questions.md changes. Use $TODAY as today's date throughout, including the output filename."

"$CLAUDE_BIN" -p "$PROMPT" \
  --settings "$REPO/scripts/devlog-cron-settings.json" \
  --allowedTools "Read,Glob,Grep,Edit(./devlog/**),Write(./devlog/**)" \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  >> "$LOG" 2>&1
status=$?

# Best-effort desktop notification (cron has no session bus by default).
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
if command -v notify-send >/dev/null 2>&1; then
  if [ "$status" -eq 0 ]; then
    notify-send "Orivon devlog" "Sunday draft ready: devlog/updates/$TODAY.md"
  else
    notify-send "Orivon devlog" "Draft FAILED (exit $status) — run /devlog manually. See devlog/.cron.log"
  fi
fi
exit "$status"
