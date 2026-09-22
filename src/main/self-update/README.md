# `src/main/self-update/`: check, notify, never install

**What lives here.** `update-check.ts`: the update decision — compares the running version
against the latest GitHub release, notifies, never installs (build-plan.md's "Auto-install is
cut" note). `update-check-runner.ts`: real wiring for it — persistence, the GitHub fetch, the
notification. `github-release-version.ts`: semver parsing and comparison for GitHub release
tags, split out of `update-check.ts` for size (Rule 2) — deliberately not merged with
[`../../broker/policy/update.ts`](../../broker/policy/update.ts)'s comparator, which accepts a
different, deliberately looser grammar for a different purpose (the manifest version floor,
security-model.md T19) than a GitHub tag needs.

**What it depends on.** `electron` (type only in `update-check-runner.ts`; the real
`Notification`/`net`/`shell` values are imported dynamically inside the functions that use them
— a top-level static value import from `electron` is silently broken under this repo's vitest
outside a real Electron process), `node:fs/promises`, `node:path`, the top-level `registry.ts`.

**What it must never import.** Nothing from [`../consent/`](../consent/) or
[`../install/`](../install/) — this directory's whole reason to exist is that a browser update
and an app-capability grant are different questions asked in different dialogs, decided by
different rules (ADR-0005 vs. the update decision's own semver floor).

**Owner stream.** `shell`. Maintenance only. `update-check-runner.ts`'s own
`updateCheckSubsystem` is not currently listed in `../subsystems.ts` and has no importer
anywhere in the repo; its own header documents the opt-in as intentional.
