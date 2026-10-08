# `src/contracts/`: the durable interface

**What lives here.** The complete `orivon.*` surface that apps program against, as TypeScript
types. Ten files, and reading them in order (`errors` -> `handles` -> `manifest` ->
`capability-api` -> `trust` -> `devices`) is the fastest way to understand what Orivon actually is.

**Changing it.** Beyond the own-PR rule: a change an app would feel needs a line under `### Changed for apps` in
`CHANGELOG.md`, the snapshot rewritten (`node scripts/app-behaviours/check-contracts-surface.mjs --update`), and
for a new capability kind its line and rows in [`test/app-behaviours/`](../../test/app-behaviours/README.md).
CI fails the missing changelog line, the stale snapshot and a capability kind with no coverage line.

**What it depends on.** Its own siblings, and nothing else. `ReadableStream`,
`WritableStream` and `Uint8Array` are ambient globals here, so they need no import at all.

**What it must never import.** `electron`, `node:*`, any package, anything outside this
directory. Two reasons, and the first is the important one:

1. This interface must outlive the engine beneath it. Tying it to `electron` would make the
   durable asset depend on the disposable one, which is precisely backwards
   ([`ADR-0002`](../../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).
2. Every stream depends on this directory at once. A dependency edge added here is inherited
   by all of them.

Enforced by `npm run check:contracts`, which runs in CI.

**Owner stream.** `contracts`, **change-controlled**. A change here touches every stream, so
it goes in its **own pull request, merged before** anything builds on it. Never modify this
directory in the same PR as an implementation.

**Source of truth.** These files are a *transcription* of
[`capability-api.md`](../../docs/architecture/capability-api.md) and
[`handle-contracts.md`](../../docs/architecture/handle-contracts.md). Those documents are the
specification. If the two disagree, the documents win and this directory is wrong.
