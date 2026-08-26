# The task catalogue

`tasks.json` is the machine-readable version and the source of truth. This page explains its
shape and how to change it safely.

## Why it is hand-written

A wrong decomposition produces busywork that looks exactly like progress, and nobody notices
until a week of unattended cycles has gone into it. So the catalogue is authored and reviewed
by a person, never generated at runtime.

`tasks.test.ts` enforces what the loop relies on — run `npm test` after any edit:

| Assertion | Why it matters |
|---|---|
| No dependency cycle, no dangling dependency | A cycle deadlocks the loop silently |
| Dependencies appear before dependents | Array order is also priority order, so it must be a valid plan |
| Every task that writes `src/broker/` is `opus` | Owner decision L2 — the security core does not get the cheaper model |
| No two *independent* tasks claim overlapping paths | Two agents writing the same file is the one failure worktree isolation cannot prevent |
| The low-value backlog is non-empty | Without it the loop jumps straight from "blocked" to "guess", which is the order L3 exists to avoid |
| Low-value tasks have no dependents | Otherwise "never blocks anything" is false |

## Fields

| Field | Meaning |
|---|---|
| `id` | Stable. Used in branch names (`stream/<id>`) and on the board |
| `category` | The **pause switch** on the dashboard. Pausing `browser-ui` stops that work and nothing else |
| `model` | `opus` for `src/broker/**`, `sonnet` elsewhere |
| `paths` | What the task may write. **These bound parallelism** — keep them tight, because two tasks with overlapping paths never run in the same cycle |
| `dependsOn` | Task ids. An unmerged dependency with an open PR is **stacked on**, not waited for |
| `lowValue` | Useful, but never blocks anything. The L3 fallback |
| `definitionOfDone` | What the agent is actually asked to achieve. **This is the prompt** — vagueness here is the most expensive mistake in the file |

## Order is priority

The loop dispatches in array order, so the file *is* the critical path from
[`build-plan.md`](../docs/planning/build-plan.md), written down:

```
broker (01-10) -> shim -> loader -> fixture/e2e
                                 \
telemetry, packaging, trust, nostr run alongside -- no shared paths
```

`broker-01-origin` is first on purpose. Origin keys storage, session partitions, grants and
derived identity keys, and [`ADR-0003`](../docs/decisions/ADR-0003-local-first-storage.md) says
changing it after the first grant is persisted orphans every app's data.

## Adding a task

1. Put it in dependency order.
2. Give it the tightest `paths` that still let it finish.
3. Write a `definitionOfDone` that a stranger could execute — it is handed to the agent verbatim.
4. `npm test`.

## What is deliberately absent

**The torrent app (build step 5).** It needs a working shim, loader and broker, and it is the
flagship — the piece where a subtly wrong result is most expensive and where the owner will
most want to steer. It gets added once the layers beneath it are merged, not queued
speculatively behind four unapproved PRs.
