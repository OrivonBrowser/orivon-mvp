# `src/shim/child-process/`: Node's `child_process`

**What lives here.** The `child_process` module target ([`../module-map.ts`](../module-map.ts)). A
child is WebAssembly or JavaScript in a Web Worker ([`../worker/`](../worker/)), never an
operating-system process
([`ADR-0040`](../../../docs/decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)):
`spawn`, `execFile` and `exec` run a WASI program from the app's bundle over [`../wasi/`](../wasi/),
or a WASI 0.2 component over [`../wasi-p2/`](../wasi-p2/), which can open sockets; `fork` runs an
app module with `process.send` and an IPC channel. Durable: no Electron API.

Also `thread.ts`'s `Worker`, `worker_threads`' target (`../polyfills/worker-threads.ts`), not
`child_process`'s: it lives beside `fork` because it wraps the same `ChildProcess` and reuses
`spawn.ts`'s `launchChild()`, minus IPC and plus its own `parentPort` `MessageChannel`.

`host-client.ts` is [ADR-0046](../../../docs/decisions/ADR-0046-an-app-s-children-live-until-its-last-page-closes.md)'s
page-side half: the connection handshake to the app's own child host, and the remote-Worker
adapter `launchChild()` (`spawn.ts`) routes a spawn or a fork through alike, whenever a host
answers. Where none does (a page outside Orivon, a Worker's own nested children, a unit test),
`launchChild()` starts a same-process Worker exactly as it always has. A spawn's own program is
loaded by whichever side actually starts the Worker -- the page for a same-process Worker, the
host for a host-routed one ([`../worker/host.ts`](../worker/host.ts)) -- since a compiled
`WebAssembly.Module` cannot cross the page -> host hop. `thread.ts`'s `Worker` never asks for a
host connection at all: a thread stays local to whatever created it, so a `SharedArrayBuffer` or a
shared `WebAssembly.Memory`/`Module` in its `workerData` never has to cross into another process.

**What it depends on.** [`../../contracts/`](../../contracts/) (types), [`../worker/`](../worker/),
[`../wasi/`](../wasi/), [`../wasi-p2/`](../wasi-p2/) (`run.ts`, to check a component's jco output), `../fs/paths.ts`, `../node-errors.ts`, `../errors.ts`,
`../orivon-global.ts`, `../warn-once.ts`, `../polyfills/module-proxy.ts`, and the `buffer`,
`events` and `stream` polyfills.

**What it must never import.** `electron`, or [`../../broker/`](../../broker/): see the parent
README.

**Owner stream.** `shim`.

**How a command resolves** (`program.ts`): a path on the app's own origin, tried as given and with
`.wasm` added. A preview1 program runs; a WASI 0.2 component runs from the jco output the port
ships beside it, under `<program>.p2/`, which may also be shipped alone ([`../wasi-p2/`](../wasi-p2/)
says how, and a raw component refuses as `ENOEXEC` naming the command); a native program (ELF, PE, Mach-O, a `#!` script) is
refused by name as `ENOEXEC` with `reason: 'excluded'`; anything missing is `ENOENT`, Node's own
answer, so "is the tool installed" checks take their ordinary branch. A port whose code spawns a
computed path ships the WebAssembly build at that path, or its bridge rewrites the path.

**`spawnSync`/`execSync`/`execFileSync` work only in a Worker of a cross-origin isolated app**
([`ADR-0016`](../../../docs/decisions/ADR-0016-synchronous-file-reads-are-permitted.md)'s
amendment), over a request kind of their own on the Worker's synchronous channel
(`spawn-sync.ts`'s `runSpawnSync`, served where a Worker's `orivon.*` already is, `spawn.ts`'s
`launch()`) -- the grandchild runs on the SERVING side (the page, or a forked child serving its
own nested thread) exactly as `spawn`/`execFile`/`exec` would there, and only the Worker that asked
blocks. Elsewhere -- the page, or a Worker with no `SharedArrayBuffer` -- they still refuse by
name: that thread cannot wait either way.

**Refused by name:** `shell`, `uid`/`gid`, a stream or descriptor as stdio, `'ipc'` in `spawn`, a
command `exec` could run only through a shell, and a `fork` `execPath` other than the page's own.

## Design notes

**`spawn` gives a program `/` as the app's files and `.` as its `cwd`**, both preopens, since a
WASI program has no working directory of its own; wasi-libc resolves a relative path against `.`.

**`close` waits for every stdio stream to close, and a stream nobody reads is drained at exit**, as
Node's `flushStdio` does; without it an unread `stderr` would hold `close` forever.

**A trap is reported as `exit` with `signalCode: 'SIGABRT'`** and the trap on `stderr`, as Node
reports a crashed child; a revoked grant is `SIGKILL`. `kill()` terminates the Worker whatever the
signal named, and `signalCode` reports the name passed.

**`fork`'s `execArgv` is accepted and ignored**: Node flags have nothing to configure in a Worker.

**`kill()` stops the Worker at once and emits `'exit'` a turn later**, as Node's arrives after the
operating system reaps the child; code that calls `kill()` and then listens for `'exit'` sees it.
`kill(0)` answers whether the child still runs. A Worker the page cannot create (a CSP without
`blob:` workers, no `window.orivon`) is a spawn failure: `'error'`, then `'close'`.

**A spawned or forked child's lifetime is its app's, not its page's** ([`ADR-0046`](../../../docs/decisions/ADR-0046-an-app-s-children-live-until-its-last-page-closes.md)).
Routed through a child host, it outlives the page that started it, for as long as another page of
the same app is open, and ends only with the app's last page -- `detached` and `unref()` do not
extend it further. The page that started it stops hearing from it the moment its own connection
port closes (a navigation, a close, a crash): the child keeps running, its stdin ends, and a fork
is told to disconnect, the same signal a real Node child gets when its parent process dies. Its
output is acknowledged rather than queued -- a chunk waiting on an ack the gone page can no longer
send is acked by the host itself, so a still-writing child is never blocked -- but goes nowhere:
nothing reattaches a later page to a child already running, and an app that wants to reach one
again does so the way its own code already would, by the port a daemon it started opened. A
`worker_threads` thread's lifetime is not this rule's: a thread lives and dies with whatever
started it (the page, or a forked child already covered by it), the way a Node thread lives and
dies with its process.
