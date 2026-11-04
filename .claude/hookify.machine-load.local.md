---
name: warn-heavy-command-on-a-shared-machine
enabled: true
event: bash
pattern: (?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npm\s+(?:test\b|run\s+(?:test:e2e|smoke|qa\S*|build|typecheck)\b)|npx\s+(?:vitest|tsc)\b|node\s+scripts/(?:build-e2e|build-ordinary|smoke)\.mjs)
action: warn
---

**A heavy command on a machine that has crashed under load.**

The owner's PC (8 cores, 23 GB) also runs their editor, which carries every agent session, a
live dev server and their own apps. Running out of memory has taken the editor down. The aim is
both: the editor never crashes, and the machine's spare capacity stays busy. Before running this:

- Send it through `~/.claude/orivon-fleet/bin/heavy`, one command per call. The gate decides when
  it starts: once its memory fits beside what runs, at idle CPU priority, capped at 2 cores and
  4 GB. Do not hold it back by hand, wait on `uptime`, or override the gate with `HEAVY_*`
  variables.
- `~/.claude/orivon-fleet/bin/heavy-why` says why a command waits. Start a long one with
  `run_in_background` and act on its notification instead of polling.
- Keep vitest narrow: `npx vitest run --maxWorkers=2`. Each worker past the 2 cores costs memory
  and gains nothing.
- Run only the tests your change can affect: `npm run test:changed`. The whole unit suite runs
  in CI on the pull request.
- The whole e2e suite runs in CI on the pull request. Locally, run named e2e files only.
