# `src/preload/` — the privilege boundary

**What lives here.** Three preload scripts at three different privilege levels (a third,
`newtab.ts`, added 2026-08-28 for the new-tab dashboard), plus `orivon-surface.ts` — not a
preload entry itself, but the `orivon.*` exposure both `app.ts` and `newtab.ts`'s fallback
branch share (build step 2's IPC task; §The rule that governs this directory still applies to
it) — and four files it depends on: `socket-bridge.ts` (the only file touching
`ipcRenderer.on(PORT_CHANNEL)`, and deliberately kind-agnostic — it maps a handle id to a port and
does not care what kind of socket it belongs to), `socket-port.ts` and `datagram-port.ts` (the
isolated-world per-socket state machines for TCP and UDP, both Electron-free), and
`main-world-socket.ts` (the one function serialised into the main world via
`contextBridge.executeInMainWorld` — see its own header before touching it). This is the
narrowest and most security-critical surface in the repository.

**What it depends on.** `electron` (via `require` — these are CommonJS),
[`src/contracts/`](../contracts/) for types.

**What it must never import.** [`src/broker/`](../broker/) — a preload runs in the renderer
process, and importing broker LOGIC there would either fail or, worse, appear to work. **One
documented exception to "never import `src/main/`":** [`../main/channels.ts`](../main/channels.ts)
is a zero-dependency leaf of plain string constants, safe in either process, and the one
neutral place a channel name shared across this trust boundary can live — `shell.ts` and
`newtab.ts` already relied on this before `orivon-surface.ts` did too. Nothing else under
`src/main/` is fair game.

**Owner stream.** `app.ts`, `orivon-surface.ts`, `socket-bridge.ts`, `socket-port.ts`,
`datagram-port.ts` and `main-world-socket.ts` belong to `broker` (build step 2); `shell.ts` and
`newtab.ts` belong to
`shell` (build step 1, done).

| File | Loaded by | Exposes |
|---|---|---|
| `app.ts` | **every ordinary tab** | `orivon-surface.ts`'s `exposeOrivon()`: `orivon.version`, `orivon.app.manifest`/`grants`, `orivon.fs.readFile`/`writeFile`/`readFileSync` (the last one ADR-0016's synchronous exception -- see `orivon-surface.ts`'s own `fsReadFileSync`), `orivon.id.publicKey`/`sign`, `orivon.net.connect` (a real `TcpSocket`) and `orivon.net.udpBind` (a real `UdpSocket`), both built in the main world by `main-world-socket.ts` |
| `shell.ts` | **only** the chrome view | Tab commands |
| `newtab.ts` | **only** a genuinely fresh tab (`src/main/tabs.ts`'s `createTab()`, no `url` argument) | Read-only bookmark access, navigate-this-tab-only — but only after checking `location.href` against its own expected URL first, since (unlike the chrome view) a dashboard tab is ordinary and navigable; falls back to the SAME `exposeOrivon()` `app.ts` uses otherwise, not a second copy |

**Preload builds are isolated per entry (`electron.vite.config.ts`'s `isolatedEntries: true`).**
Found 2026-08-28: the moment a second preload (`newtab.ts`) shared a local import with `shell.ts`
(`./channels.js`), Rollup's default multi-entry build extracted it into a shared chunk that a
sandboxed preload's restricted `require()` cannot load — `contextBridge.exposeInMainWorld` never
ran, and the whole chrome UI went silently inert with no visible error. `isolatedEntries` keeps
each preload a single, fully self-contained bundle.

## The rule that governs this directory

**The raw `MessagePortMain` never crosses into the main world.** `socket-bridge.ts`,
`socket-port.ts` and `datagram-port.ts` hold it in the isolated world and expose only plain closures over it —
`write(chunk)`, `onData(cb)`, and so on (`socket-port.ts`'s own `SocketPort`). Transferring the
port to the page is the obvious move when optimising for throughput, and it hands a raw socket
to anything the page can reach ([`security-model.md`](../../docs/architecture/security-model.md)
T17). `main-world-socket.ts`'s `installOrivon` builds the page's real `ReadableStream`/
`WritableStream` in the main world over exactly these closures — the closures cross via
`contextBridge.executeInMainWorld`'s proxying, the port itself never does.

This is a **security rule, not a throughput optimisation left for later**. `contextIsolation:
true` is what makes it free. Spike gate 0 measured 1134.8 MB/s *through the closures* for the
`exposeInMainWorld` mechanism -- **stale for `net.connect`'s path specifically** (AR-F8): that
number predates this PR's shift to `executeInMainWorld` for the `net` surface, which adds a
`contextBridge` clone on top of the structured clone already in the path (three copies of every
byte, two of them on the renderer main thread). Re-measurement against the new path is pending;
until then this is not evidence for `net.connect`'s throughput, only for `app.*`/`fs.*`'s.

The smoke check asserts `require` and `process` are `undefined` in every renderer. If that ever
regresses, stop.

## Design notes

**Why `orivon-surface.ts` is shaped the way it is**, moved here from its own header per
code-guidelines.md's destination test (none of this is a trap a single line needs; it explains
the file's overall shape):

- **Shared by both exposure sites.** `preload/app.ts` (every ordinary tab) and
  `preload/newtab.ts`'s fallback branch (a dashboard tab the user has navigated away from) both
  call this file's `exposeOrivon()`, so there is exactly one `orivon.*` object definition, not
  two copies drifting apart (code-guidelines.md Rule 3).
- **This is build step 2's control surface** -- `../broker/transport/ipc.ts`'s `handleControlRequest`, on
  the other side of `CONTROL_CHANNEL`. `app.manifest`, `app.grants`, `fs.readFile`,
  `fs.writeFile`, `id.publicKey`, `id.sign`, `net.connect`, `net.udpBind`, `net.close` (plus
  `net.setNoDelay`/`setKeepAlive`) are wired there; `fs.readFileSync` is wired the same way but
  over its OWN channel (`SYNC_CONTROL_CHANNEL`, `../broker/transport/sync-fs.ts`'s
  `handleSyncFsReadRequest`), never as a twelfth `CONTROL_CHANNEL` method, because it replies via
  `event.returnValue`, not a resolved `Promise`. Everything else in
  `docs/architecture/capability-api.md` (`net.listen`, `fs.open`/`mkdir`/`readdir`/`stat`/`rm`/
  `rename`/`userSelected`, `id.requestIdentity`, `app.requestGrant`) is simply absent -- the
  broker does not implement the rest yet either (`id.requestIdentity` specifically needs the
  connect-prompt UI, a later build step), and a method that always threw `'invalid'` would be
  worse than a method that is not there.
- **`net.connect`'s real shape (readable/writable are actual WHATWG streams) cannot be built in
  the isolated world.** `contextBridge` copies plain values into the main world; it does not
  proxy a stream built on this side intact (checked live via context7 against Electron's own
  docs: "Function values are proxied, while other data types are copied and frozen" -- a copied
  `ReadableStream` loses its prototype). `./main-world-socket.ts`'s `installOrivon` is therefore
  handed to `contextBridge.executeInMainWorld`: it runs IN the main world, so its own
  `ReadableStream`/`WritableStream` are the page's real constructors, wired to plain proxied
  closures (`netConnectBridge`) built in `orivon-surface.ts`.
- **`CONTROL_CHANNEL` is imported from `../main/channels.js`, not `../broker/`,** deliberately,
  matching `preload/shell.ts`'s own precedent (`COMMAND_CHANNEL`/`STATE_CHANNEL`, same file):
  this directory's "never import `src/broker/`" rule is about broker LOGIC, which cannot run in
  a renderer process at all -- `channels.ts` is a zero-dependency leaf of plain string constants,
  safe in either process, and the one neutral place a channel name shared across this trust
  boundary can live.
