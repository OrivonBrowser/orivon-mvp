---
name: warn-shell-backgrounded-runner
enabled: true
event: bash
pattern: (?:cross-os\.mjs|live-session\.mjs\s+start|pr-watch\.mjs)[^;\n]*\s&(?!&)
action: warn
---

**A long runner put in the background with a shell `&` dies when this tool call returns.**

`node scripts/ci/cross-os.mjs`, `live-session.mjs start` and `scripts/ai/pr-watch.mjs` wait minutes to hours. A
trailing `&` inside one Bash call leaves the process attached to that call's shell, which ends with the call: the
GitHub run goes on, but nothing collects its evidence, and a watcher never merges. Run the command on its own with
the Bash tool's `run_in_background: true` instead; you are told when it ends. A run already started can be followed
again with `node scripts/ci/cross-os.mjs --run <run id>`.
