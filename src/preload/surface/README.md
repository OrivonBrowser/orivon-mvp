# `src/preload/surface/`: `window.orivon`'s page surface

**What lives here.** The `orivon.*` exposure every ordinary tab gets: `orivon.ts`
(`exposeOrivon()`, shared by `../app.ts` and `../newtab.ts`'s fallback, so there is one
definition), `control-call.ts` (the `CONTROL_CHANNEL` call and timeout machinery), `net.ts` and
`web.ts` (bridge closures), and `main-world-socket.ts`, the one function serialised into the
main world, with its types in `main-world-bridges.ts`.

**What it depends on.** `electron` (via `require`), [`../../contracts/`](../../contracts/) for
types, [`../../main/channels.ts`](../../main/channels.ts) (the parent README's one exception),
[`../orivon-error.ts`](../orivon-error.ts) and [`../ports/`](../ports/).

**What it must never import.** [`../../broker/`](../../broker/), as the parent README says.
Nothing under [`../routed/`](../routed/): its installers are serialised alone and share nothing
with this folder's.

## Design notes

**Why `orivon.ts` is split three ways.** A new `net.*` method grows `net.ts`, not the file every
other capability lives in. `control-call.ts` is a leaf both import, which is how `net.ts` shares
`call()` without a cycle back through `orivon.ts`.

**Why the streams are built in the main world.** `contextBridge` copies a stream built in the
isolated world as a dead, frozen object, so `main-world-socket.ts`'s `installOrivon` runs in the
page and builds real streams over proxied closures
([ADR-0014](../../../docs/decisions/ADR-0014-main-world-streams-via-experimental-api.md)). It
locks `window.orivon`, the one page global that stays locked
([ADR-0021](../../../docs/decisions/ADR-0021-page-globals-carry-the-platform-descriptor.md)).

**What is wired, and what is left off.** The broker side is
`../../broker/transport/ipc.ts`'s `handleControlRequest`; `fs.readFileSync` alone goes over
`SYNC_CONTROL_CHANNEL`
([ADR-0016](../../../docs/decisions/ADR-0016-synchronous-file-reads-are-permitted.md)). Left
off under the parent README's rule, because the broker does not implement them: `fs.open`'s
`readable()`/`writable()`, and `id.requestIdentity`, which needs the connect-prompt UI.
