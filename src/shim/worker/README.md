# `src/shim/worker/`: children in Web Workers

**What lives here.** What a child needs to run in a Web Worker: the Worker's runtime
(`runtime.ts`, with `runtime-spawn.ts` for a WASI program or a WASI 0.2 component,
`runtime-fork.ts` for an app module, and `runtime-thread.ts` for one run as a `worker_threads`
thread, sharing `runtime-fork.ts`'s `setupChildProcess` for the Node process a child gets), the
page-side server and Worker-side client that carry the Worker's `orivon.*` calls to the page
(`orivon-server.ts`, `orivon-client.ts`), the shared-memory channel for its synchronous calls
(`sync-channel.ts`), `node-port.ts` (a web `MessagePort` in Node's shape: `worker_threads`'
`parentPort`, `MessageChannel` and `MessagePort`), and `launch.ts`, which starts a Worker.
[`../child-process/`](../child-process/) is the one user today: `child.ts`'s `ChildProcess` and
`spawn.ts`'s launch routing back `fork` and `thread.ts`'s `Worker` alike. A Worker reaches exactly
what its page could, since it is the app's own code
([`ADR-0040`](../../../docs/decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)).
Durable: it uses Web Workers, `MessagePort` and JSPI, no Electron API.

**`host.ts`/`host-protocol.ts`: the child host's own relay** (ADR-0046). A spawn or a fork runs in
a Worker of the app's hidden host, never the page that started it; `host.ts` is what runs inside
that host, one real Worker per child, relaying between the Worker's ordinary `./protocol.ts`
traffic and the page's own dedicated port for that child (`host-protocol.ts`'s
`ToHostChild`/`StartChildMessage` -- a different, extra hop in front of the same
`ToWorker`/`FromWorker` protocol, not a replacement for it). `../child-process/host-client.ts` is
the page's own half: the connection handshake and the remote-Worker adapter that lets
`launchChild()` route through a host exactly as it would start a local Worker. A spawn's own
program (`../child-process/program.ts`'s `loadProgram`) is loaded by the host itself, never
carried across the page -> host hop: a compiled `WebAssembly.Module` does not survive it
(ADR-0046's Context). A `worker_threads` thread never takes this route: it stays a local Worker of
whatever started it (ADR-0046's amendment), so `thread.ts`'s `Worker` never asks for a host
connection at all.

**What it depends on.** [`../../contracts/`](../../contracts/) (types), [`../wasi/`](../wasi/),
[`../wasi-p2/`](../wasi-p2/), [`../child-process/program.ts`](../child-process/program.ts) (for
`host.ts`'s own spawn loading), `../globals.ts`, `../virtual-root.ts`, and the `buffer` and
`stream` polyfills. Loading a program reaches a bare `import ... from 'path'`
(`../fs/paths.ts`, `../wasi/fds.ts`), which `host.ts` bundles into a real preload script, not
through the app bundler's own aliasing -- the preload build's own resolve plugin
(`electron.vite.config.ts`'s `shimNodeSpecifiers`) resolves it the same way, for any importer
under `src/shim/`, and for a package the shim brings in (readable-stream asks for `buffer` and
`util`) whenever the builtin is one a sandboxed preload cannot `require` (all but `events`,
`timers` and `url`).

**What it must never import.** `electron`, or [`../../broker/`](../../broker/): see the parent
README.

**Owner stream.** `shim`.

## Design notes

**`electron.vite.config.ts`'s `shimNodeSpecifiers` needs a `config` hook, not only `resolveId`.**
A plugin's `resolveId` alone cannot resolve a shim's bare Node specifier for the preload build:
electron-vite's own preset puts every Node builtin into `rollupOptions.external` as a plain array,
and Rollup's module loader checks THAT before calling any plugin's `resolveId` at all (measured: a
shim importer's own `resolveId` here never ran, `require('path')` still in the built output) -- an
array only Rollup's own `getIdMatcher` consults, so a matching id is external whatever a plugin
would otherwise have resolved it to. The plugin's `config` hook runs after that preset's own (same
`enforce: 'pre'` bucket, later in the assembled plugin list) and replaces `external` with an
equivalent FUNCTION -- the one form of that option a plugin's `resolveId` still gets to run
underneath, since `getIdMatcher` calls a function form directly rather than pattern-matching an
array.

**`runtime.generated.json` is `runtime.ts` bundled, and it is checked in.** A child Worker starts
from that text through a `blob:` URL, which works whatever bundler a port uses and passes the served
CSP's `worker-src 'self' blob:`. `tests/runtime-bundle.test.ts` fails when it is stale: after
changing anything the runtime imports, run it with `ORIVON_WRITE_WORKER_RUNTIME=1`.

**A forked child or thread gets a global `require`** (`runtime-fork.ts`'s `setupChildProcess`),
the loader behind `createRequire` ([`../polyfills/cjs-loader.ts`](../polyfills/cjs-loader.ts)):
esbuild's `__require` helper reads a global `require` when a bundle's dynamic `require` runs. The
loader's builtin table statically holds most of the shim, which makes `runtime.generated.json`
roughly five times larger than it was without it; every child pays that parse, a spawned WASI
program included.

**A forked child's console is a `Console` over its `process.stdout` and `process.stderr`**
(`routeConsole`, [`../polyfills/console-class.ts`](../polyfills/console-class.ts)), as Node's is: every
method (`dir`, `table`, `assert`, `group`, `time*`, `count*` as well as `log` and `error`) reaches the
parent's `child.stdout` and `child.stderr`, and a program that patches either `write` sees the output.
The Worker's own console still gets every call.

**`early-globals.ts` must stay the runtime's first import.** Polyfills in the bundle read
`process` while they load; in a tab the preload installs it first, and in a Worker this module does.

**A stream whose chunks are handles is pumped, every other stream is transferred.**
`TcpServer.connections` yields sockets, which carry streams of their own that structured clone
cannot copy, so the server reads it one socket at a time (`HANDLE_STREAMS`). A new contract stream
of handles must be added there, or its transfer fails.

**A handle's plain fields are copied once**, when it crosses: a live counter such as
`UdpSocket.droppedInbound` reads its value at that moment.

**A Worker's synchronous calls block on the page through shared memory** (`sync-channel.ts`).
The Worker posts the call as usual and waits in `Atomics.wait`; the page makes it on its own
`orivon` and writes the reply into a `SharedArrayBuffer`, in 1 MiB chunks. Only a cross-origin
isolated app has `SharedArrayBuffer`: elsewhere a Worker's `readFileSync` refuses by name, and an
addon's file calls refuse with `NOSYS`. The synchronous twin sits under
`Symbol.for('orivon.synchronous')` on the Worker's `orivon`, a registered symbol so each bundle's
shim finds the same one. It is not part of the contract, and `window.orivon` has none. A reply
carries no stream, so a call returning one refuses, and the page closes what that call opened. **Never make a synchronous call from the
thread that serves it**: it waits forever, which is why `tests/sync-channel.test.ts` runs the
Worker end in a `worker_threads` thread. Every path-based `fs` `*Sync` call ([`../fs/`](../fs/))
rides this same twin, one `orivon.fs` member at a time; `readFileSync`/`existsSync` alone also work
outside a Worker, over the runtime's own synchronous channel
([`ADR-0016`](../../../docs/decisions/ADR-0016-synchronous-file-reads-are-permitted.md)).

**`child_process.spawnSync`/`execSync`/`execFileSync` are not an `orivon.*` call, so they carry
their own request kind over the same channel** (`orivon-server.ts`'s `CallBody`'s `spawnSync`
variant, `sync-channel.ts`'s `Symbol.for('orivon.spawnSync')` on the Worker's `orivon`). `serveOrivon`
takes an optional `runSpawnSync` to answer it, given only where a Worker's `orivon.*` is served
([`../child-process/`](../child-process/)'s `spawn.ts`'s `launch()`) -- the grandchild it starts
runs on THIS thread, asynchronously, same as any other child; only the Worker that asked blocks.

**A Worker that starts a child serves its own `orivon` to it, and the call travels up to the page.**
`serveOrivon` finds a method only among an object's own properties, so a name inherited from
`Object.prototype` is never callable; the Worker's `orivon` is a Proxy, so `orivon-client.ts` gives
it a `getOwnPropertyDescriptor` trap that reports what `get` answers. What exists is still decided
once, by the page's server against the real `orivon`.

**Disposing the server closes every handle the Worker still holds**, so a killed child leaves no
slot open in the broker's per-app handle table.

**A forked module's first IPC messages wait until it has run, or until it listens for
`'message'`** (`runtime-fork.ts`): its code loads asynchronously, and in Node a child's top level
runs before any message is processed, while a top-level `await` on the first message must still
receive it.

**A forked child ends on its own as a Node child does** (`liveness.ts`): once nothing holds its IPC
channel (no `'message'` or `'disconnect'` listener, or the channel closed) and no timer, immediate,
fetch, `orivon.*` call or open handle is pending, it emits
`'beforeExit'`, then `'exit'`, and ends with code 0. Scheduling that must not keep it alive uses
the unwrapped `setTimeout` that `trackScope` returns.

**A child's timers are Node's objects** (`liveness.ts`): `setTimeout`, `setInterval` and `setImmediate`
return a value with `ref`, `unref`, `hasRef`, `refresh` (timers) and `close`, which reports a number when
asked, and `clearTimeout` takes the object or that number. A server library calls `refresh()` on its ping
timer and `unref()` on a keep-alive, so a bare id would end the child with a `TypeError`. An unref'd timer
does not keep the child alive.

**A thread ends on its own the same way, minus the IPC channel** (`runtime-thread.ts`): what
keeps it alive instead is a ref'd `parentPort` listener. `node-port.ts`'s wrapper calls back only
on the 0-to-1 or 1-to-0 edge of "ref'd, started, and at least one `'message'`/`'messageerror'`
listener", never on every listener change, since a caller's own ref count would otherwise be
double-counted. `unref()`, `close()`, or the last listener going away all release it. Unlike
Node, a message a thread posts on `parentPort` just before it exits can reach the parent after
`'exit'`: the two travel on separate channels, and nothing orders one against the other yet.

**A `worker_threads.Worker` nested in a forked child keeps that child alive while it is ref'd**
(the default): `runtime-fork.ts` publishes its own `Liveness` under `FORK_LIVENESS_SYMBOL`, which
`thread.ts`'s `Worker` reads off `globalThis` at construction and refs; nothing does outside a
fork, where nothing here ever exits on its own. Both this and `WORKER_THREADS_SYMBOL` (what a
thread's own `isMainThread`/`parentPort`/`workerData` and a nested-thread refusal read) are
registered symbols in `symbols.ts`, a leaf module, so every bundle's copy of the shim agrees on
the same one and the page's `worker_threads` names them without importing the runtime.

**The stdout sink posts a copy of each chunk**, never the host's own array: transferring it would
detach it, and the host reads its length afterwards for `fd_write`'s byte count, which a libc
checks before writing again.

**`host.ts` acks an orphaned child's output itself, rather than let it block.** A child's next
chunk of a stream waits for an ack the PAGE normally sends once it reads the chunk
(`../worker/parent.ts`'s `OutputAcks`); once the page's port is gone nothing else ever will, so a
still-running child that keeps writing (any daemon logs) would otherwise hang at its very next
write. Closing the port flushes one ack per stream immediately (unblocking a write already
waiting), and every `output` message the Worker sends afterward gets its own ack in reply instead
of a relay to the dead port.

**`host.ts`'s own page<->host port must be closed-watched with `addEventListener('close', ...)`,
never the `.onclose` property.** Measured directly: a real Chromium renderer's `MessagePort`
dispatches `'close'` to a listener added either way, but under plain Node -- which is what this
file's own unit tests (`tests/host.test.ts`) run a `MessagePort` pair under -- only
`addEventListener` ever fires it; `.onclose = ...` is silently never called. `addEventListener`
is what both agree on, so that is the only form used here.
