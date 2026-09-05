# `src/preload/` — the privilege boundary

**What lives here.** Three preload scripts at three different privilege levels (a third,
`newtab.ts`, added 2026-08-28 for the new-tab dashboard), plus `orivon-surface.ts` — not a
preload entry itself, but the `orivon.*` exposure both `app.ts` and `newtab.ts`'s fallback
branch share (build step 2's IPC task; §The rule that governs this directory still applies to
it) — and three files it depends on: `socket-bridge.ts` (the only file touching
`ipcRenderer.on(PORT_CHANNEL)`), `socket-port.ts` (the isolated-world per-socket state machine,
Electron-free), and `main-world-socket.ts` (the one function serialised into the main world via
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

**Owner stream.** `app.ts`, `orivon-surface.ts`, `socket-bridge.ts`, `socket-port.ts` and
`main-world-socket.ts` belong to `broker` (build step 2); `shell.ts` and `newtab.ts` belong to
`shell` (build step 1, done).

| File | Loaded by | Exposes |
|---|---|---|
| `app.ts` | **every ordinary tab** | `orivon-surface.ts`'s `exposeOrivon()`: `orivon.version`, `orivon.app.manifest`/`grants`, `orivon.fs.readFile`/`writeFile`, `orivon.net.connect` (a real `TcpSocket`, built in the main world by `main-world-socket.ts`) |
| `shell.ts` | **only** the chrome view | Tab commands |
| `newtab.ts` | **only** a genuinely fresh tab (`src/main/tabs.ts`'s `createTab()`, no `url` argument) | Read-only bookmark access, navigate-this-tab-only — but only after checking `location.href` against its own expected URL first, since (unlike the chrome view) a dashboard tab is ordinary and navigable; falls back to the SAME `exposeOrivon()` `app.ts` uses otherwise, not a second copy |

**Preload builds are isolated per entry (`electron.vite.config.ts`'s `isolatedEntries: true`).**
Found 2026-08-28: the moment a second preload (`newtab.ts`) shared a local import with `shell.ts`
(`./channels.js`), Rollup's default multi-entry build extracted it into a shared chunk that a
sandboxed preload's restricted `require()` cannot load — `contextBridge.exposeInMainWorld` never
ran, and the whole chrome UI went silently inert with no visible error. `isolatedEntries` keeps
each preload a single, fully self-contained bundle.

## The rule that governs this directory

**The raw `MessagePortMain` never crosses into the main world.** `socket-bridge.ts`/
`socket-port.ts` hold it in the isolated world and expose only plain closures over it —
`write(chunk)`, `onData(cb)`, and so on (`socket-port.ts`'s own `SocketPort`). Transferring the
port to the page is the obvious move when optimising for throughput, and it hands a raw socket
to anything the page can reach ([`security-model.md`](../../docs/architecture/security-model.md)
T17). `main-world-socket.ts`'s `installOrivon` builds the page's real `ReadableStream`/
`WritableStream` in the main world over exactly these closures — the closures cross via
`contextBridge.executeInMainWorld`'s proxying, the port itself never does.

This is a **security rule, not a throughput optimisation left for later**. `contextIsolation:
true` is what makes it free. Spike gate 0 measured 1134.8 MB/s *through the closures*, so there
is no performance argument for weakening it.

The smoke check asserts `require` and `process` are `undefined` in every renderer. If that ever
regresses, stop.
