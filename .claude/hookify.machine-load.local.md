---
name: warn-heavy-command-on-a-shared-machine
enabled: true
event: bash
pattern: (?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npm\s+(?:test\b|run\s+(?:test:e2e|smoke|qa\S*|build|typecheck)\b)|npx\s+(?:vitest|tsc)\b|node\s+scripts/(?:build-e2e|build-ordinary|smoke)\.mjs)
action: warn
---

**A heavy command on a machine that has crashed under load.**

The owner's PC (8 cores, 23 GB) also runs their editor, a live dev server and other agent
sessions. Parallel test suites, builds and Electron launches have taken the editor down more
than once. Before running this:

- Run one heavy command at a time across every session and agent: typecheck, the unit suite,
  a build, e2e, smoke. Wait for another one to end rather than starting beside it.
- Lower its priority and width: `nice -n 15`, and `npx vitest run --maxWorkers=2`.
- Run only the test files you touched while working; the whole unit suite once at the end.
- The whole e2e suite runs in CI on the pull request. Locally, run named e2e files only.
- Keep at most three agents working at once, and at most one of them running tests.
- Check `uptime` and `free -m` first: with a 1-minute load above 8 or under 5 GB available, wait.
