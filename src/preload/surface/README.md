# `src/preload/surface/`: `window.orivon`'s page surface

**What lives here.** The `orivon.*` exposure every ordinary tab gets: `orivon.ts` (not a preload
entry itself, but the exposure `app.ts` and `newtab.ts`'s fallback branch share), its two Rule 2
splits `control-call.ts` (the shared `CONTROL_CHANNEL` call/timeout machinery) and `net.ts` (the
`net.*` bridge closures; see Design notes for why these split out), `web.ts` (the `web.*` bridge),
and `main-world-socket.ts` -- the one function serialised into the main world via
`contextBridge.executeInMainWorld` (see its own header before touching it) -- with its types in
`main-world-bridges.ts`.

**What it depends on.** `electron` (via `require`), [`../../contracts/`](../../contracts/) for
types, [`../../main/channels.ts`](../../main/channels.ts) (the one documented exception to
`src/preload/`'s "never import `src/main/`" rule -- see the parent README), and
[`../orivon-error.ts`](../orivon-error.ts) and [`../ports/`](../ports/) (`main-world-socket.ts`
builds the page's streams directly over the port state machines).

**What it must never import.** [`../../broker/`](../../broker/) -- see the parent README's
"What it must never import" for why. Nothing under `../routed/`: the routed network path's
installers are each serialised alone (see `../routed/README.md`) and share nothing with this
folder's own main-world installer.

**Owner stream.** `broker`, build step 2.

## Design notes

**Why the page surface is three files (`orivon.ts`, `control-call.ts`, `net.ts`).** Every new
capability method adds page-surface entries, and in one file they would all converge on it: the
same merge-time failure mode `../../broker/transport/ipc.ts`'s own split
(`../../broker/transport/README.md`'s Design notes) exists to avoid. The net.* bridge closures
(`netConnectBridge`, `netConnectSecureBridge`, `netUdpBindBridge` and everything only they use --
`wrapPort`, the local `SocketDescriptor`/`UdpSocketDescriptor` shapes, `buildBridgeResult`,
`buildUdpBridgeResult`) live in `net.ts`, so a new `net.*` method grows that file, not the one
every other capability's code also lives in. `call()`, `raceTimeout()` and the per-capability
`TIMEOUT_MS` budgets live in `control-call.ts`, because both `orivon.ts` (the
`app.*`/`fs.*`/`id.*` closures, `exposeFallback`, `exposeOrivon`) and `net.ts` need them, and
`net.ts` importing them from `orivon.ts` directly would cycle back through `orivon.ts`'s own
import of the net bridge closures for `exposeOrivon`'s wiring object; `control-call.ts` is a leaf
neither file needs to route through the other to reach.

**Why `orivon.ts` is shaped the way it is** (none of this is a trap a single line needs; it
explains the file's overall shape):

- **Shared by both exposure sites.** `preload/app.ts` (every ordinary tab) and
  `preload/newtab.ts`'s fallback branch (a dashboard tab the user has navigated away from) both
  call this file's `exposeOrivon()`, so there is exactly one `orivon.*` object definition, not
  two copies drifting apart (code-guidelines.md Rule 3).
- **This is build step 2's control surface**: `../../broker/transport/ipc.ts`'s
  `handleControlRequest`, on the other side of `CONTROL_CHANNEL`. `app.manifest`, `app.grants`,
  `app.requestGrant`, `fs.readFile`, `fs.writeFile`, `fs.mkdir`/`readdir`/`stat`/`rm`/`rename`,
  `fs.open` and its handle-scoped siblings (`fs.read`/`write`/`fstat`/`truncate`/`sync`/`close`,
  A184), `fs.userSelected`'s FILE shape (A194, reusing those same handle-scoped siblings) and its
  FOLDER shape (A195: `fs.dirOpen`/`dirReaddir`/`dirStat`/`dirMkdir`/`dirRm`/`dirRename`/
  `dirReadFile`/`dirWriteFile`), `id.publicKey`, `id.sign`, `net.connect`, `net.connectSecure`,
  `net.udpBind`, `net.listen`, `net.lookup`, `net.close` (plus `net.setNoDelay`/`setKeepAlive`)
  are wired there; `fs.readFileSync` is wired the same way but over its OWN channel
  (`SYNC_CONTROL_CHANNEL`, `../../broker/transport/sync-fs.ts`'s `handleSyncFsReadRequest`), never
  one more `CONTROL_CHANNEL` method, because it replies via `event.returnValue`, not a resolved
  `Promise`. **Update this bullet in the same PR that lands a method here.** `fs.open`'s own
  `readable()`/`writable()` (A184) and `id.requestIdentity` are absent, because the broker does
  not implement them either (`id.requestIdentity` needs the connect-prompt UI, a later build
  step), and a method that always threw `'invalid'` would be worse than a method that is not
  there.
- **`net.connect`'s real shape (readable/writable are actual WHATWG streams) cannot be built in
  the isolated world.** `contextBridge` copies plain values into the main world; it does not
  proxy a stream built on this side intact (checked live via context7 against Electron's own
  docs: "Function values are proxied, while other data types are copied and frozen", so a copied
  `ReadableStream` loses its prototype). [`main-world-socket.ts`](main-world-socket.ts)'s
  `installOrivon` is therefore handed to `contextBridge.executeInMainWorld`: it runs IN the main
  world, so its own `ReadableStream`/`WritableStream` are the page's real constructors, wired to
  plain proxied closures (`netConnectBridge`) built in `orivon.ts`.
- **`CONTROL_CHANNEL` is imported from `../../main/channels.js`, not `../../broker/`,**
  deliberately, matching `preload/shell.ts`'s own precedent (`COMMAND_CHANNEL`/`STATE_CHANNEL`,
  same file): the parent directory's "never import `src/broker/`" rule is about broker LOGIC,
  which cannot run in a renderer process at all: `channels.ts` is a zero-dependency leaf of plain
  string constants, safe in either process, and the one neutral place a channel name shared
  across this trust boundary can live.

**Why [`main-world-socket.ts`](main-world-socket.ts) still locks `window.orivon` when the rest of
`src/preload/` is not locked.** `orivon` is Orivon's own surface rather than a borrowed one:
nothing tries to shadow it, the platform sets no contract for its shape, and freezing it costs an
app nothing, so the reason in that file's own comment stands. The guard's allowlist carries the
same four names for the same reason.

**The raw `MessagePortMain` never crosses into the main world, from here either.** See the parent
README's "The rule that governs this directory" -- this folder's `main-world-socket.ts` is the
file that builds the page's real streams over [`../ports/`](../ports/)'s closures, never over the
port itself.
