# `src/broker/`: the capability broker

**What lives here.** The grant model, per-origin enforcement, the handle tables, and the IPC that
reaches the page. **This is the product**: everything else in the repository exists so that this
can be reached from a web page
([`ADR-0002`](../../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).

**What it depends on.** [`src/contracts/`](../contracts/) and `electron`.

**What it must never import.** [`src/shim/`](../shim/), [`src/loader/`](../loader/), or any
renderer code. The broker is the authority; importing one of its consumers inverts the trust
direction and makes the boundary meaningless.

**Tied to Electron?** Only [`transport/`](transport/). Everything else runs in plain Node with
stub dependencies.

**Owner stream.** `broker`.

**Traps.** The origin definition keys storage, session partitions, grants and derived keys;
changing it once a grant is persisted orphans every app's data
([`ADR-0003`](../../docs/decisions/ADR-0003-local-first-storage.md)). Connect patterns are
checked against **resolved addresses**, never hostnames, or DNS rebinding defeats them (T12 in
[`security-model.md`](../../docs/architecture/security-model.md)).

## The layout

Six directories, one per job
([`ADR-0015`](../../docs/decisions/ADR-0015-the-broker-is-organised-by-job.md),
[`ADR-0035`](../../docs/decisions/ADR-0035-src-source-directories-are-organised-by-job.md)).
These boundaries are prose, enforced by nothing ([`A85`](../../docs/open-questions.md)).

| Directory | Job | Holds state? | Touches I/O? |
|---|---|---|---|
| [`policy/`](policy/) | **Decide**: may this origin do this? | no, pure functions | **never** |
| [`grants/`](grants/) | **Remember**: what did the user approve? | yes, per origin | disk, for persistence |
| [`handles/`](handles/) | **Hold**: what is this origin holding, and can I take it back? | yes, per origin | **never**, `destroy` is injected |
| [`adapters/`](adapters/) | **Do**: dial the address, open the file | no | **yes**: the only place, bar `grants/node-ledger-storage.ts` |
| [`transport/`](transport/) | **Speak**: reach the page, move the bytes | connection registry | Electron IPC and ports |
| [`capabilities/`](capabilities/) | **Expose**: the `orivon.*` entry points | no | via the other five |

Top-level files belong to no single directory: [`index.ts`](index.ts) (`createBroker`),
[`errors.ts`](errors.ts) (constructs an `OrivonError`), [`io-errors.ts`](io-errors.ts)
(translates a raw errno; kept apart from `errors.ts` while A39 is open), and
[`broker-contracts.ts`](broker-contracts.ts) (the `Broker` interface and its dependency shape),
which re-exports the five other `*-contracts.ts` files, so import from it.
[`embed-contracts.ts`](embed-contracts.ts) is what the shell's embed host asks before a
`<webview>` attaches or loads a document (`ADR-0039`).

**Reading order, cold:** [`src/contracts/`](../contracts/), then
[`policy/connect.ts`](policy/connect.ts)'s header for how security is reasoned about here, then
[`capabilities/net.ts`](capabilities/net.ts)'s `connect()` for one call end to end.

## Design notes

### `policy/reserved-ports.ts`: what a blanket grant does not reach

A `*:*` grant is legitimate (a P2P app's peers are anywhere), but it would make the origin an
outbound traffic generator from the user's IP on any port. The ports with an abuse history and
no legitimate use from a page are excluded from every blanket grant, and reached only by a
pattern that names the exact port, which a person then approved. It does not limit egress rate
(accepted, [`A82`](../../docs/open-questions.md)), and private addresses are already denied by
`policy/address.ts`. `udp.send` gets the same rule, since `authorisedSend` reuses
`checkConnect`. Why a range is not a naming, why the check is per pattern, and where it runs:
`reserved-ports.ts` and `connect-preflight.ts`.

### `index.ts` and the files split from it

`index.ts` keeps what every capability shares: the dependency shape `createBroker` fixes, the
origin-normalising `canonical()`, and the `app` and grant-ledger entry points, which cascade
ledger changes through `handleTable`. Each capability's entry points are in
[`capabilities/`](capabilities/), taking `HandleTable` and `GrantLedger` as constructed
dependencies, so `createBroker`'s shape and its stub tests do not change when one moves.

### `policy/manifest-patterns.ts` must map every declarable capability

A capability missing from `patternSetFromCapabilities` is invisible to both consumers: a
manifest update that adds it installs silently (`decideUpdate` never sees it), and
`app.requestGrant` refuses it as undeclared. `policy/tests/manifest-patterns.test.ts` pins the
mapping.

### Elsewhere

Grant hydration: [`grants/README.md`](grants/README.md). The capability entry points
(`connectSecure`'s address check, `listen`'s accept-queue bound, `fs` `open` and quota, `web`'s
`evaluate` timeout): [`capabilities/README.md`](capabilities/README.md). The unlink hook, the
byte pumps and `relay/socket.ts`: [`transport/README.md`](transport/README.md)'s Design notes.
The Node adapters: [`adapters/README.md`](adapters/README.md).
