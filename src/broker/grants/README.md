# `src/broker/grants/`: what the user actually agreed to

**What lives here.** The per-origin ledger of manifests and grants, its persistence across
restarts, and the origin hash that names an origin's storage on disk.

**What it depends on.** [`src/contracts/`](../../contracts/), [`../policy/`](../policy/),
[`../adapters/atomic-write.ts`](../adapters/atomic-write.ts), and
`node:fs`/`node:path`/`node:crypto`.

**What it must never import.** `electron`, [`../handles/`](../handles/) or
[`../transport/`](../transport/). This directory is *consulted by* those; an edge the other way
would let a transport detail decide what a grant means.

**Tied to Electron?** No. `node-ledger-storage.ts` is the only file that touches disk, through
Node.

**Owner stream.** `broker`.

## The rule this directory exists to hold

**A capability check reads the GRANTS, never the manifest.** The manifest is what an app
declared; the grant is what a person approved (`open-questions.md` A18). `GrantLedger` holds
both, apart, so the narrowing happens in one place: the capability entry points.

## Design notes

**Three storage roots.** `ledger-storage.ts`'s real implementation keeps the ledger under its own
`grants/` root; the `fs` capability's files live under their own `app-data/<hash>/files`
(`./origin-hash.ts`'s `appDataRoot`, consulted by `../adapters/node-fs-adapter.ts`'s `nodeFs`),
separate from the loader's own `apps/<hash>` state (pinned code, staging, `pin.json`) so a pin
re-verify and an app's declared quota govern two disjoint trees (T13b). App removal has to clear
all three.

**`LedgerStorage` is synchronous, unlike `LoaderStorage`, on purpose.** Callers invoke
`Broker.registerApp` without awaiting it, which is safe only because nothing inside it yields;
an async write would let the next line run before the write landed.
`loader/cache/node-storage.ts` uses sync `fs` for tiny files for the same reason.

### `grant-persistence.ts`: what a persisted grant may trust (A23)

Grants read back from disk are untrusted. `hydrateGrants` keeps only the entries that still pass
`decideGrantRequest` against the manifest registered **this session**, never the one in force
when the grant was made, and mints a fresh `GrantId` (`PersistedGrant` has no id). Hydration is
never a second place authority can be minted.

- **Grants hydrate at `registerApp`**, not when a record is first touched as the version floor
  and the declined set do, because re-validating needs a manifest. `grantsHydrated` makes it
  happen once per origin per session, so a later `registerApp` cannot undo an in-session revoke.
- **`hydrateFromPinnedManifest` runs the same read earlier** (A158), from a manifest proven a
  leaf of a hash-pinned bundle (`src/loader/serve/serve.ts`'s `verifiedManifestFor`). That ties
  it to a bundle the person consented to, which a manifest saved bare to disk is not (A137's
  ruling): forging it means forging a pin record and a matching bundle, the boundary cached
  serving already relies on. The later `registerApp` replaces whatever it seeded.
- **Writes are whole-file**: the full grant set, on every `grant()`/`revoke()`, so a reader never
  sees half a change. Loopback and plain-http origins are not persisted either way (T13c).

**`resource-limits.ts` answers "how much may this origin use"**, a separate question from what
it was granted. The socket budget is the declared `net.concurrentSockets`, clamped (never
rejected) to `LIMITS.concurrentSockets`, with a modest `LIMITS.defaultConcurrentSockets` so an
app that needs more must declare a number a person sees at grant time (A80).

**`declined-consent.ts` is advisory only** (A145). A remembered "no" can suppress
`src/main/consent/install-consent.ts`'s dialog and nothing else: nothing that grants reads it,
and `app.requestGrant` stays a separate door.
