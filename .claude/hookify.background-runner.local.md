---
name: warn-shell-backgrounded-runner
enabled: true
event: bash
pattern: (?:cross-os\.mjs|live-session\.mjs\s+start|pr-watch\.mjs)[^;\n]*\s&(?!&)
action: warn
---

**A long runner put in the background with a shell `&` runs on, but nothing tells you when it ends.**

`node scripts/ci/cross-os.mjs`, `live-session.mjs start` and `scripts/ai/pr-watch.mjs` wait minutes to hours. Behind a
trailing `&` the session is never told the result, so it is easy to believe the process gone and start a second one:
two `pr-watch.mjs` on one pull request push over each other and the later one stops on `head moved`. Run the command
on its own with the Bash tool's `run_in_background: true` instead, so its end is reported. Before starting another,
look for the first: `pgrep -af "pr-watch.mjs <n>"`. A run already started is followed again with
`node scripts/ci/cross-os.mjs --run <run id>`.
