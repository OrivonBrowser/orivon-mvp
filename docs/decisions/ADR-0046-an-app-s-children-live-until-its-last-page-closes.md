# ADR-0046: An app's children live until its last page closes, in a hidden host of the app's own

- **Status:** accepted
- **Date:** 2026-09-29
- **Type:** architecture
- **Decided by:** owner

## Decision

A child process an app starts (`spawn`, `exec`, `execFile`, `fork`) runs in a hidden **child
host** the shell keeps for that app, not in the page that started it. The shell creates the host
when the app first starts a child, and closes it once no page of the app is left open; every
child in it ends then. So a child outlives the page that started it while another page of the app
is open, and never outlives the app's last page: `detached` and `unref()` do not extend it.
Reloading an app's only page ends its children, as closing it would.

A `worker_threads` thread is not a child process, and this lifetime rule does not cover it: a Node
thread lives and dies with the process that started it, so it stays a local Worker of whatever
created it (the page, or a forked child already running in the host), never routed through the
child host itself. That keeps a `SharedArrayBuffer` or a shared `WebAssembly.Memory`/`Module` in
its `workerData` reachable, which crossing into another renderer process would break.

The host is a page at the app's own origin, in a session of its own, that runs Orivon's host script
and never the app's own page code. It carries the app's grants, its CSP and, when the manifest asks,
cross-origin isolation, and it is never shown. The children are Web Workers it starts: their
`orivon.*` calls and open handles belong to it, so a socket a child opened survives the page that
started it. A page reaches its children through ports the main process connects to the host.

The host is an offscreen, never-attached `WebContentsView`, not a hidden window of its own: it
does not count toward Electron's window total, so it never keeps the process alive. Closing the
last visible window ends the process as it always has (`src/main/index.ts`'s `window-all-closed`
handler quits, except on macOS outside a private session), and every host and child with it;
where the process stays, a host closes with its app's last page.

This amends [ADR-0040](./ADR-0040-native-shaped-node-features-run-as-webassembly.md)'s "in the
app's tab": a child still runs as WebAssembly or JavaScript in a Web Worker, at the normal broker
allowance, never as machine code.

## Context

A child was a dedicated Worker of the page that spawned it, so closing or reloading that page ended
it while another page of the app was still open. A daemon an app runs for all its pages, reached
over loopback, died with whichever page happened to start it. The owner's rule for native-shaped
features is that an app's processes end with its last page.

Measured in Electron 44:

- A `SharedWorker` per app origin has the wanted lifetime (it survives one of two pages and ends
  with the last), but it cannot start nested Workers and is never cross-origin isolated, so it can
  host neither a child nor a child's synchronous calls.
- A handle that reaches a page rides a `MessagePort`, and the broker releases it when that port
  closes: whatever hosts a child must own the child's handles too.
- A hidden page at the app's origin, in an in-memory session that answers its own document with the
  app's headers, is cross-origin isolated; its preload's calls carry the app's origin; a `blob:`
  Worker in it imports the app's modules and starts nested Workers; and its timers keep full rate
  while never shown.
- A compiled `WebAssembly.Module` does not cross from one renderer process to another, so the host
  loads a program itself.
- **Host shape.** An offscreen, never-attached `WebContentsView` looks, at first, like it destroys
  the whole app the moment the one visible tab closes: Electron quit every time in that
  configuration. Isolating it found the real cause has nothing to do with offscreen rendering,
  GPU, ports, or Workers -- it is Electron's own window count. Destroying the tab's `BrowserWindow`
  with no other counted window left triggers Electron's default `window-all-closed` quit, and a
  never-attached `WebContentsView` is not a counted window at all, so a host built with nothing
  else present dropped the count to zero. Orivon registers its own `window-all-closed` handler
  (`src/main/index.ts`), so closing a tab while another window is open never quits, and the last
  window closing quits exactly as it would with no host: the host adds nothing to the window count,
  which is the property wanted, since a hidden window of its own would keep the process running
  after the person closed every window.

## Alternatives considered

- **A `SharedWorker` per app.** Measured out, above.
- **A reserved path in the app's own session.** Works for an installed app, whose bundle Orivon
  serves, and not for an app served by its own server, where Orivon only rewrites headers.
- **A `data:` document with the app's origin as its base.** It takes the origin but carries no
  headers, so it is never cross-origin isolated and a child's synchronous calls would stop working.
- **A child ends with its page.** The simplest; the owner chose the app's last page instead.
- **A native process host.** Excluded by ADR-0040.
- **A hidden window of the host's own** (a `BrowserWindow` or a `BaseWindow` holding the host's
  view). Measured to work, and rejected: it counts as a window, so the process would keep running
  after the person closed every visible window, until the shell learned to discount it.

## Reasoning

The host is the one place that can own a child for the whole app: a page at the app's origin gets
the app's grants from the broker unchanged, since the broker keys grants by origin, and a session of
its own lets the shell answer its document for both kinds of app without touching how the app's own
pages are served. Children keep running as they do today, as Workers of a page; only which page
changes.

## Consequences

- The page reaches its children through `contextBridge` closures that hold no port (T17) and
  apply the page-caller check `window.orivon` applies
  ([ADR-0045](./ADR-0045-window-orivon-refuses-extension-code-a-filter-not-a-sandbox.md)): an
  extension's script in the page gets no child of the app's.
- **Tied to Electron:** the host's lifecycle and session (`src/main/children/`). **Durable:** the
  host script and the routing in the shim (`src/shim/worker/`, `src/shim/child-process/`).
- A child's web storage (IndexedDB, Cache Storage) is the host session's, not the app pages'.
  Node-shaped code keeps its state through `orivon.fs`, which is the app's; a child that reaches for
  web storage sees a store of its own, cleared when its host closes -- the partition name is
  stable per origin, and nothing here promises a child's web storage outlives its own host.
- A child's WebSocket uses the host session's own network stack directly, gated by whatever CSP
  and grants the host was built with -- unlike `fetch`, it is never seen by a page's own service
  worker either way, since the delegation underneath it is a main-process dial, not a request any
  registration can intercept. A host has no `RTCPeerConnection` to give a child at all.
- A host is rebuilt, never merely reused, once the origin's live grants move past what it was
  built with -- checked on the next child a page starts, so an already-running child keeps its old
  session and CSP until then or until the app's last page closes, whichever comes first.
- Program loading moves from the page to the host for a spawn or a fork alike. Loading a
  spawned program pulls in a dependency a real preload script cannot bundle on its own (measured:
  an unresolved `path` import throws, taking the whole preload down, not only spawn); the preload
  build resolves it the same way the app bundler already does for the app's own code, through a
  resolve plugin scoped to an importer under `src/shim/` (`electron.vite.config.ts`'s
  `shimNodeSpecifiers`, reproducing `src/shim/module-map.ts`'s table rather than a second one).
- A page that goes away leaves its children to the app. Nothing reattaches a new page to them, as
  nothing in Node reattaches a restarted parent; an app finds its daemon again the way its own code
  does, by its port.
- One hidden page, and its renderer process, per app that has children running.

## Reversibility

- **Cost to reverse:** moderate. Going back to "a child ends with its page" is a routing change in
  the shim and the removal of `src/main/children/`; no app contract changes.
- **What would make us revisit:** `SharedWorker` gaining nested Workers and cross-origin isolation
  in the engine Orivon runs on, or the memory of one host per app becoming a measured problem.
