# `src/broker/grants/`: what the user actually agreed to

**What lives here.** The per-origin ledger of manifests and grants, its persistence across
restarts, and the origin hash that names an origin's storage on disk.

**What it depends on.** [`src/contracts/`](../../contracts/), [`../policy/`](../policy/), and
`node:fs`/`node:path`/`node:crypto`.

**What it must never import.** `electron`, [`../handles/`](../handles/) or
[`../transport/`](../transport/). This directory is *consulted by* those; an edge the other way
would let a transport detail decide what a grant means.

**Owner stream.** `broker`, build step 2.

## The rule this directory exists to hold

**A capability check reads the GRANTS, never the manifest.** The manifest is what an app
*declared* it wants; the grant is what a person *approved*, and the two are not the same set
(`open-questions.md` A18). `GrantLedger` holds both, deliberately apart, so the narrowing has
exactly one place it can happen: [`../index.ts`](../index.ts)'s capability entry points.

## Design notes

**`origin-hash.ts` is here because storage identity follows the ledger.** The same origin key
that names a grant record names the directory holding that origin's files and its persisted
version floor. Changing it after the first grant is persisted orphans every app's data
([`ADR-0003`](../../../docs/decisions/ADR-0003-local-first-storage.md)).

**`node-ledger-storage.ts` is the only file here that touches disk**, behind
`ledger-storage.ts`'s interface. It is grouped by what it is *about* (grants) rather than by
what it *touches* (`node:fs`), the same call [`../adapters/`](../adapters/) makes in the other
direction. If a second Node-backed store ever lands here, revisit that.

**`ledger-storage.ts`'s real implementation puts everything under its own `grants/` root, with
one exception.** `node-adapters.ts`'s `nodeFs` (the `fs` capability's confined bytes, a different
piece of broker state entirely) writes under the loader's own `apps/<hash>/files` instead, which
predates `ledger-storage.ts` and is unchanged by it, so "one root per subsystem" holds for the
grant ledger specifically, not as a whole-tree guarantee. Whoever eventually builds app removal
has to know about both roots.

**`LedgerStorage` is synchronous, not Promise-based like `LoaderStorage`, deliberately.**
`GrantLedger`'s own `registerApp`/`versionFloorFor`/`grant`/`revoke` are relied on throughout this
codebase's tests as effectively synchronous: dozens of call sites invoke `Broker.registerApp`
without awaiting its `Promise<void>`, which only ever worked because nothing inside it actually
yielded. Making persistence genuinely async would turn every one of those into a real race (the
next line could run before the write landed): a correctness regression, not just a test-fixup
exercise. A tiny per-origin JSON file is exactly the class of operation `loader/cache/node-storage.ts` already
chose sync `fs` APIs for (`codeRoot`'s `mkdirSync`, `resolveAssetPath`'s `realpathSync`), for the
same reason.

### `grant-persistence.ts`: what a persisted grant may trust (A23)

Split out of `grant-ledger.ts` (code-guidelines.md Rule 2) once persisting the grants themselves
pushed that file toward its 500-line limit. The read half, `hydrateGrants`, is the security core
of the whole feature: it reads whatever `LedgerStorage.readGrants` returns for an origin and
keeps only the entries that still pass `decideGrantRequest` (`../policy/request-grant.ts`)
against that origin's manifest **as registered THIS session**, never the manifest that was in
force when the grant was originally made. A grant that no longer fits, because the manifest narrowed or
dropped the capability entirely, is silently dropped rather than restored, exactly mirroring
what a fresh `requestGrant()` call would refuse right now. A restored grant always gets a FRESH
`GrantId`; nothing here ever trusts an id read off disk, because there is not one to trust:
`PersistedGrant` carries no `id` field at all.

**Hydration runs from `GrantLedger.registerApp`, not from `#record`'s create branch the way
`versionFloor`'s own hydration does.** The floor and the rollback acknowledgement are plain
values with no dependency on anything else, so they can hydrate the moment a record is first
touched, before `registerApp` has ever run. Grants cannot: re-validating them needs a manifest,
and there is no manifest until `registerApp` provides one. `OriginRecord.grantsHydrated` is the
guard that makes this happen exactly once per origin per session, on that origin's first
registration, never on a later reload, so an in-session revoke is never silently undone by a
second `registerApp` call re-reading the same stale disk state.

**`hydrateFromPinnedManifest` is the same read, run early (A158), not a second implementation of
it.** `registerApp`'s hydration above waits for a fresh manifest, but there is a second, narrower
source that already carries the same guarantee a fresh `registerApp` manifest does: a manifest that is a verified leaf
of a hash-pinned bundle (`src/loader/serve/serve.ts`'s `verifiedManifestFor`, gated on
`serve/verify.ts`'s `verifyPinnedTree`) is cryptographically tied to the exact bundle a person
already consented to, not merely "a value saved to disk" in the sense `A137`'s ruling forbids
trusting as authority. `A137`'s withdrawn attempt hydrated from a manifest persisted bare, for
hydration's own sake, with no such tie: an attacker with local write access could plant a
self-consistent `(manifest.json, grants.json)` pair at the cost of two flat files. Reusing the
pinned-bundle manifest costs an attacker forging a whole pin record plus a bundle whose hash
matches it, which is not new attack surface this adds: it is `verifyPinnedTree`'s EXISTING
boundary for cached serving, the same one every already-installed app already relies on. This
method is a no-op once `registerApp` has actually run (`grantsHydrated`), and `registerApp`'s own
branch now clears whatever this seeded before re-deriving from the fresh manifest, so the later,
really-fetched manifest stays fully authoritative. The owner's own point: a manifest change
changes the bundle hash, which is itself enough to restart the status of permissions. Full account:
`docs/open-questions.md` A158's 2026-09-14 resolution.

**Write side (`persistGrants`, `grantsToPersist`) is the ledger's live `grants` map, reshaped for
disk and written back in full on every `grant()`/`revoke()`**: one JSON file per origin holding
every capability it currently holds, keyed by capability kind. A single whole-file write, never
an incremental patch, is what keeps a reader from ever observing a set with one grant added but
another not yet removed. T13c (loopback/plain-http origins are session-scoped only) gates both
directions the same way `versionFloor`'s own persistence already does, and `isPersistableOrigin` is
checked before either a read or a write.

**Revoke deletes one capability from the persisted set; `forgetOrigin` deletes the whole file.**
These are deliberately different operations, matching `ADR-0009`'s 2026-09-04 amendment: an
ordinary revoke is scoped to one capability and leaves the rest of the origin's grants (and its
version floor) untouched, while a full "remove this app" action (`forgetOrigin`, A60's escape
hatch, doubling as A23's removal primitive) forgets everything about the origin at once,
including every persisted grant, so nothing reappears on the next restart.

**`replaceHydratedGrants` reuses an id across two hydration passes for unchanged authority, and
reports the ones it does not (A168).** `hydrateFromPinnedManifest` and the first real
`registerApp` for the same origin both call it, and neither is guaranteed to be the ONLY one that
ever runs for an origin whose bundle did not change. A live handle's `authorisedBy.grantId`
(`../handles/handle-store.ts`) is frozen at acquire time and never rebinds, so minting a fresh
`GrantId` on the second pass for a byte-for-byte identical pattern set would leave
`revoke`/`revokePersisted` unable to find a handle acquired between the two passes, ever: the
revoke button would lie. So each capability's restored patterns are compared against whatever
the ledger's `grants` map already holds for it, order-independently (`sameOwnPatterns`,
`../policy/update.ts`, shared with `src/main/consent/grant-changed-capabilities.ts` one layer up), and the
OLD `Grant` object, id included, is reused on a match. Every capability that is NOT a
match, whether dropped outright or replaced by genuinely different patterns, is returned as a
`SupersededGrant`, because an id is the only thing safe to carry forward silently; real authority
never is. `GrantLedger` has no `HandleTable` reference (this file's own header), so it can only
report that list; `../index.ts`'s `createBroker` wrapper is what cascades it through
`handleTable.revoke`, in both its `registerApp` and `hydrateFromPinnedManifest` wrappers, using
the same unconditional ordering `revokePersisted`/`grant`/`revoke` already use elsewhere in that
file: ledger mutation first, cascade after, regardless of whether a disk write failed.

### `declined-consent.ts`: remembering a "no" without it ever becoming a "yes" (A145)

A fifth per-origin file, `declined-capabilities.json`, alongside the floor, rollback
acknowledgement and grants, written when `src/main/consent/install-consent.ts`'s all-or-nothing dialog
is DECLINED, so a restart does not ask the same question again as if nothing had happened.

**What is stored is the declared capability set the dialog was declined for, never a boolean,
never a manifest.** A boolean cannot answer "is this still the same question" once a manifest
changes; the whole manifest is more than the comparison needs and would reopen A137's ruling (a
value read off disk must not gain authority it would not have arriving fresh). Comparing exactly
the capability names lets `install-consent.ts` ask again only when a manifest now declares
something genuinely new, and stay silent for the same request or a narrower one.

**Hydrates eagerly, at `#record`'s create branch, following the version floor's shape rather than the grants'
(A158).** `grant-persistence.ts`'s own design note above explains why grants must wait for
`registerApp` to supply a manifest to re-validate against. A declined-capability record needs no
such re-validation: it authorises nothing, so there is nothing for a manifest to re-check it
against. Deferring its hydration to `registerApp` the way grants does would only recreate A158's
exact ordering hazard for a value that has no reason to share it.

**ADVISORY ONLY, and that is enforced by what this file's two write paths can reach, not by
convention.** `recordDeclinedConsent`/`clearDeclinedConsent` write only to their own file and to
`OriginRecord.declinedCapabilities`; neither touches `grants`, and nothing in `grant()` or
`decideGrantRequest` (`../policy/request-grant.ts`) ever reads this field. A remembered no can
suppress `install-consent.ts`'s own dialog and nothing else: `app.requestGrant`
(`src/main/consent/request-grant.ts`), the app's own live per-capability door, is a completely separate
path to a grant, untouched by this record either way.

**A failed write is logged, never thrown, unlike the version floor's.** The floor's write
failing is security-relevant (T19's replay guard would silently weaken); a lost decline-record
write costs one avoidable re-prompt next restart, never a security regression, so it is held to
the same best-effort standard `forgetOrigin`'s own disk cleanup already uses for the same reason.
`GrantLedger.forgetOrigin` itself is the one caller that does NOT use this file's
`clearDeclinedConsent`, because that function's internal swallow-and-log would break `forgetOrigin`'s
own stricter contract (a failed delete must leave the in-memory record untouched), so it calls
`storage.deleteDeclinedCapabilities` directly instead, inside its own all-four-or-nothing try
block alongside the floor, rollback acknowledgement and grants deletes.

### `resource-limits.ts`: how much an origin may use, not what it was granted

Split out of `grant-ledger.ts` (code-guidelines.md Rule 2) once the A168 fix pushed that file to
its 500-line limit with no headroom left (A177). `socketAllowance`/`reserveFsBytes`/
`releaseFsBytes` read nothing but `manifest.capabilities.net.concurrentSockets`/`fs.quotaBytes`
and the origin's own running byte count: they answer "how much of an already-declared resource
ceiling has this origin used", a question with no comparison or write path in common with
grant-persistence.ts's "was this capability actually approved" or update-safety.ts's "may this
version install". `GrantLedger` keeps the per-origin record and the public methods; this file
keeps the arithmetic, the same split shape as `update-safety.ts` and `declined-consent.ts` above.
