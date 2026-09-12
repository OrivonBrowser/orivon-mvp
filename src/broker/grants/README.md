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

**`ledger-storage.ts`'s real implementation puts everything under its own `grants/` root, with
one exception.** `node-adapters.ts`'s `nodeFs` (the `fs` capability's confined bytes, a different
piece of broker state entirely) writes under the loader's own `apps/<hash>/files` instead — that
predates `ledger-storage.ts` and is unchanged by it, so "one root per subsystem" holds for the
grant ledger specifically, not as a whole-tree guarantee. Whoever eventually builds app removal
has to know about both roots.

**`LedgerStorage` is synchronous, not Promise-based like `LoaderStorage`, deliberately.**
`GrantLedger`'s own `registerApp`/`versionFloorFor`/`grant`/`revoke` are relied on throughout this
codebase's tests as effectively synchronous: dozens of call sites invoke `Broker.registerApp`
without awaiting its `Promise<void>`, which only ever worked because nothing inside it actually
yielded. Making persistence genuinely async would turn every one of those into a real race (the
next line could run before the write landed) — a correctness regression, not just a test-fixup
exercise. A tiny per-origin JSON file is exactly the class of operation `node-storage.ts` already
chose sync `fs` APIs for (`codeRoot`'s `mkdirSync`, `resolveAssetPath`'s `realpathSync`), for the
same reason.

### `grant-persistence.ts` — what a persisted grant may trust (A23)

Split out of `grant-ledger.ts` (code-guidelines.md Rule 2) once persisting the grants themselves
pushed that file toward its 500-line limit. The read half, `hydrateGrants`, is the security core
of the whole feature: it reads whatever `LedgerStorage.readGrants` returns for an origin and
keeps only the entries that still pass `decideGrantRequest` (`../policy/request-grant.ts`)
against that origin's manifest **as registered THIS session**, never the manifest that was in
force when the grant was originally made. A grant that no longer fits — the manifest narrowed, or
dropped the capability entirely — is silently dropped rather than restored, exactly mirroring
what a fresh `requestGrant()` call would refuse right now. A restored grant always gets a FRESH
`GrantId`; nothing here ever trusts an id read off disk, because there is not one to trust —
`PersistedGrant` carries no `id` field at all.

**Hydration runs from `GrantLedger.registerApp`, not from `#record`'s create branch the way
`versionFloor`'s own hydration does.** The floor and the rollback acknowledgement are plain
values with no dependency on anything else, so they can hydrate the moment a record is first
touched, before `registerApp` has ever run. Grants cannot: re-validating them needs a manifest,
and there is no manifest until `registerApp` provides one. `OriginRecord.grantsHydrated` is the
guard that makes this happen exactly once per origin per session, on that origin's first
registration — never on a later reload, so an in-session revoke is never silently undone by a
second `registerApp` call re-reading the same stale disk state.

**Write side (`persistGrants`, `grantsToPersist`) is the ledger's live `grants` map, reshaped for
disk and written back in full on every `grant()`/`revoke()`** — one JSON file per origin holding
every capability it currently holds, keyed by capability kind. A single whole-file write, never
an incremental patch, is what keeps a reader from ever observing a set with one grant added but
another not yet removed. T13c (loopback/plain-http origins are session-scoped only) gates both
directions the same way `versionFloor`'s own persistence already does — `isPersistableOrigin` is
checked before either a read or a write.

**Revoke deletes one capability from the persisted set; `forgetOrigin` deletes the whole file.**
These are deliberately different operations, matching `ADR-0009`'s 2026-09-04 amendment: an
ordinary revoke is scoped to one capability and leaves the rest of the origin's grants (and its
version floor) untouched, while a full "remove this app" action — `forgetOrigin`, A60's escape
hatch, doubling as A23's removal primitive — forgets everything about the origin at once,
including every persisted grant, so nothing reappears on the next restart.
