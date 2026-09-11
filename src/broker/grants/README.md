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


### `forgetOrigin`, and why its three rules are ordered the way they are

`registerApp` raises the version floor unconditionally, even for a manifest that was only ever
FETCHED, never installed -- so a hostile origin can poison the floor with a fake high version and
lock the user out of every real, lower-numbered future update from it. Nothing else in
`GrantLedger` lowers, resets or clears a floor once raised. `forgetOrigin` is the only way back.

**Both halves have to go together.** Clearing only memory would let the next hydration read the
poisoned value straight back off disk; clearing only disk would leave it live for the rest of the
session.

**Disk first, then memory, and memory untouched if a delete fails.** Clearing memory first means a
failed delete leaves the poisoned floor on disk with nothing in memory to compare it against --
strictly worse than never having called it. A failed forget must change nothing.

**Logged, not thrown**, unlike `registerApp`'s write. The two are not held to one standard because
they carry different risk: `registerApp`'s write is the security-critical half of a raise that has
already happened, so hiding its failure hides a real weakening. This is best-effort cleanup, and
its failure leaves the ledger exactly as it was -- still safe, just still poisoned, which is the
state the caller was already in.

**Not an "uninstall this app" primitive.** It is correct and complete for the version floor and
the persisted grants (A23), matching ADR-0009's 2026-09-04 amendment that a full removal forgets
everything, and it now deletes the persisted manifest too. In-memory `manifest` and
`fsBytesWritten` are dropped as well. Two gaps remain open, neither reachable today since nothing
calls it yet (`docs/open-questions.md` A60):

- dropping a grant here does not revoke the handles it authorised -- that cascade belongs one
  layer up, in `createBroker`, beside the one `revoke` already performs; this class holds no
  `HandleTable` reference.
- resetting `fsBytesWritten` to zero frees no bytes on disk, so forget-then-re-register is a way
  around the fs quota until the confinement directory is actually sized (A29).

### What `hydratedCapabilities` is for

A grant restored from disk and a grant made by `Broker.grant` are re-checked differently, and the
difference is load-bearing. `Broker.grant` is the TRUSTED-side call -- the consent prompt and the
developer grant -- and is deliberately not manifest-bound; A13 records that re-registering a
manifest must leave what it granted alone. A restored grant is different: it was validated against
a manifest that was itself read off disk, so when the app is really opened and its freshly fetched
manifest arrives, that check has to run again, or an app that has since narrowed its declaration
would keep authority nothing currently asks for. `hydratedCapabilities` is how `registerApp` tells
the two apart.
