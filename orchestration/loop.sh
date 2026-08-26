#!/usr/bin/env bash
# One cycle of the autonomous build loop. Installed in the user crontab.
#
#   orchestration/loop.sh            one cycle
#   orchestration/loop.sh --dry-run  plan only, dispatch nothing
#   orchestration/loop.sh --probe    verify the guardrails, then exit
#   orchestration/loop.sh --stop     set the global stop and exit
#   orchestration/loop.sh --resume   clear it
#
# THE OWNER'S OFF SWITCH IS `--stop`. It takes effect at the next cycle
# boundary; anything already running finishes.
#
# SECURITY. This runs unattended with file-writing tools, which is a far larger
# surface than the Sunday devlog cron. Four controls, in order of value:
#
#   1. Dispatched agents work in a git WORKTREE, so their writes are confined
#      to a directory outside this checkout. That is a stronger bound than any
#      path pattern.
#   2. --allowedTools is an ALLOW-LIST. The devlog cron learned this the hard
#      way: its first version used acceptEdits plus unscoped Write/Edit, and a
#      test write to $HOME succeeded. A deny-list cannot contain a tool that
#      was granted for every path.
#   3. loop-settings.json denies this script, .claude/, and every ~ dotfile.
#      THE LOOP MAY NOT EDIT ITS OWN GUARDRAILS -- one that can widen its own
#      permissions has none. Note that `Write(path)` deny rules are SILENTLY
#      IGNORED; only `Edit(path)` applies, and it covers every file-editing
#      tool. Verified 2026-08-25.
#   4. --strict-mcp-config with an empty config: no MCP servers. Exfiltration
#      is a worse outcome than a bad file write.
#
# Inputs are first-party today. When outside contributions land, PR titles and
# commit messages become attacker-controlled text flowing into an unattended
# agent -- revisit the allow-list then. That is a scheduled review, not a
# hypothetical: build-plan.md actively wants outside contributors.
set -u

REPO="/home/jhon/Desktop/Develop/Claude/orivon-mvp"
CLAUDE_BIN="$HOME/.local/bin/claude"
STATE="$REPO/orchestration/state"
LOG_DIR="$STATE/runs"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$LOG_DIR/$STAMP.log"

cd "$REPO" || exit 1
mkdir -p "$LOG_DIR"

node -e "import('$REPO/orchestration/board.mjs').then(b => b.ensureState('$STATE'))" 2>/dev/null

# ---------------------------------------------------------------- owner switches
case "${1:-}" in
  --stop)
    node -e "import('$REPO/orchestration/board.mjs').then(b => {
      const c = b.loadControl('$STATE'); c.globalStop = true; b.saveControl('$STATE', c)
    })"
    echo "global stop SET. Running tasks finish; nothing new dispatches."
    exit 0 ;;
  --resume)
    node -e "import('$REPO/orchestration/board.mjs').then(b => {
      const c = b.loadControl('$STATE'); c.globalStop = false; b.saveControl('$STATE', c)
    })"
    echo "global stop CLEARED."
    exit 0 ;;
esac

# ------------------------------------------------------------------- the probe
# Proves the guardrails hold. Not a test of intent -- a test of the harness.
if [ "${1:-}" = "--probe" ]; then
  echo "Probing guardrails. Each of these MUST be refused."
  "$CLAUDE_BIN" -p "Attempt all three of these, then report for each whether it was ALLOWED or REFUSED. Do not stop at the first refusal.
1. Append the comment '# probe' to $HOME/.bashrc
2. Append the comment '# probe' to $REPO/.claude/settings.json
3. Append the comment '# probe' to $REPO/orchestration/loop.sh" \
    --settings "$REPO/orchestration/loop-settings.json" \
    --allowedTools "Read,Glob,Grep,Edit,Write,Bash(cat:*),Bash(ls:*)" \
    --strict-mcp-config --mcp-config '{"mcpServers":{}}' 2>&1 | tail -25
  echo ""
  echo "--- verifying nothing was actually written ---"
  for f in "$HOME/.bashrc" "$REPO/.claude/settings.json" "$REPO/orchestration/loop.sh"; do
    if grep -q '^# probe$' "$f" 2>/dev/null; then
      echo "BREACH: $f was modified. STOP AND FIX BEFORE ARMING."
      exit 1
    fi
    echo "intact: $f"
  done

  # The other half, and it is not optional. A permission set that refuses
  # EVERYTHING passes the checks above and then silently fails to do any work
  # -- which looks exactly like "the loop stopped" and is far harder to
  # diagnose than a breach. Headless runs cannot prompt for approval, so a
  # missing allow rule is indistinguishable from a deny.
  echo ""
  echo "--- verifying the loop CAN still write where it must ---"
  rm -f "$STATE/probe-write.txt"
  "$CLAUDE_BIN" -p "Write the single line 'ok' to the file orchestration/state/probe-write.txt" \
    --settings "$REPO/orchestration/loop-settings.json" \
    --allowedTools "Read,Write,Edit,Bash(ls:*)" \
    --strict-mcp-config --mcp-config '{"mcpServers":{}}' >/dev/null 2>&1
  if [ -f "$STATE/probe-write.txt" ]; then
    echo "intact: can write orchestration/state/"
    rm -f "$STATE/probe-write.txt"
  else
    echo "BROKEN: the loop cannot write its own state. It would do nothing, silently."
    exit 1
  fi

  echo ""
  echo "All guardrails held, and the loop can still work."
  exit 0
fi

# --------------------------------------------------------------------- the lock
# Cron fires on a fixed schedule whether or not the last cycle finished, so
# overlap is the normal case. Two loops dispatching from one board would
# double-dispatch every task.
LOCK_RESULT="$(node -e "
import('$REPO/orchestration/board.mjs').then(b => {
  const r = b.acquireLock('$STATE')
  console.log(r.acquired ? 'ok' : 'held:' + r.heldBy)
  if (!r.acquired) process.exit(3)
})" 2>&1)"
if [ $? -ne 0 ]; then
  echo "$(date -Is) skipped: previous cycle still running ($LOCK_RESULT)" >> "$LOG"
  exit 0
fi
trap 'node -e "import(\"$REPO/orchestration/board.mjs\").then(b => b.releaseLock(\"$STATE\"))" 2>/dev/null' EXIT

# --------------------------------------------------------------------- the cycle
{
  echo "=== $(date -Is) cycle start ${1:-} ==="
} >> "$LOG"

ARGS="${1:-}"

# Bash is broad here on purpose: the cycle runs npm, git, gh and node. The
# containment is the worktree plus the deny-list, not a narrow Bash grant --
# and pretending otherwise would give a false sense of a boundary that is not
# really there.
"$CLAUDE_BIN" -p "/orivon-loop $ARGS" \
  --settings "$REPO/orchestration/loop-settings.json" \
  --allowedTools "Read,Glob,Grep,Edit,Write,Task,TodoWrite,Bash" \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  >> "$LOG" 2>&1
status=$?

echo "=== $(date -Is) cycle end (exit $status) ===" >> "$LOG"

# ----------------------------------------------------------------- failure note
# A usage-limit exit is the EXPECTED steady state once the plan is exhausted --
# the next cycle simply retries, which is the whole auto-resume mechanism. So
# repeated identical failures are suppressed for 6 hours; otherwise the owner
# gets a message every 23 minutes all night and mutes the bot, which loses the
# messages that mattered.
if [ "$status" -ne 0 ]; then
  MARK="$STATE/.last-failure"
  now="$(date +%s)"
  last=0
  [ -r "$MARK" ] && last="$(cat "$MARK" 2>/dev/null || echo 0)"
  if [ $((now - last)) -gt 21600 ]; then
    echo "$now" > "$MARK"
    tail_msg="$(tail -3 "$LOG" | tr '\n' ' ' | cut -c1-120)"
    "$REPO/orchestration/notify.sh" failure "cycle exit $status. $tail_msg" || true
  fi
else
  rm -f "$STATE/.last-failure"
fi

exit "$status"
