# `src/broker/grants/` — what the user actually agreed to

**What lives here.** The per-origin ledger of manifests and grants, its persistence across
restarts, and the origin hash that names an origin's storage on disk.

**What it depends on.** [`src/contracts/`](../../contracts/), [`../policy/`](../policy/), and
`node:fs`/`node:path`/`node:crypto`.

**What it must never import.** `electron`, [`../handles/`](../handles/) or
[`../transport/`](../transport/). This directory is *consulted by* those; an edge the other way
would let a transport detail decide what a grant means.

**Owner stream.** `broker` — build step 2.

## The rule this directory exists to hold

**A capability check reads the GRANTS, never the manifest.** The manifest is what an app
*declared* it wants; the grant is what a person *approved*, and the two are not the same set
(`open-questions.md` A18). `GrantLedger` holds both, deliberately apart, so the narrowing has
exactly one place it can happen — [`../index.ts`](../index.ts)'s capability entry points.

## Design notes

**`origin-hash.ts` is here because storage identity follows the ledger.** The same origin key
that names a grant record names the directory holding that origin's files and its persisted
version floor. Changing it after the first grant is persisted orphans every app's data
([`ADR-0003`](../../../docs/decisions/ADR-0003-local-first-storage.md)).

**`node-ledger-storage.ts` is the only file here that touches disk**, behind
`ledger-storage.ts`'s interface. It is grouped by what it is *about* (grants) rather than by
what it *touches* (`node:fs`) — the same call [`../adapters/`](../adapters/) makes in the other
direction. If a second Node-backed store ever lands here, revisit that.
