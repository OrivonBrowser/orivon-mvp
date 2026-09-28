# `src/main/self-update/`: check, notify, never install

**What lives here.** `update-check.ts` compares the running version with the latest GitHub
release and notifies, never installs (its header says why). `update-check-runner.ts` is the real
I/O; its `updateCheckSubsystem` is not yet listed in `../subsystems.ts`.
`github-release-version.ts` parses release tags, and must not merge with the broker's version
comparator (its header says why).

**Tied to Electron.** `update-check-runner.ts` only, importing values dynamically.

**What it depends on.** `electron` (runner only), `node:fs/promises`, `node:path`, the top-level
`registry.ts`.

**What it must never import.** [`../consent/`](../consent/) or [`../install/`](../install/): a
browser update and an app grant are different questions, asked in different dialogs, under
different rules.

**Owner stream.** `shell`. Maintenance only.
