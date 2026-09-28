# `src/shim/child-process/`: Node's `child_process`

**What lives here.** The `child_process` module target ([`../module-map.ts`](../module-map.ts)). A
child is WebAssembly or JavaScript in a Web Worker ([`../worker/`](../worker/)), never an
operating-system process
([`ADR-0040`](../../../docs/decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)):
`spawn`, `execFile` and `exec` run a WASI program from the app's bundle over [`../wasi/`](../wasi/),
or a WASI 0.2 component over [`../wasi-p2/`](../wasi-p2/), which can open sockets; `fork` runs an
app module with `process.send` and an IPC channel. Durable: no Electron API.

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

**Refused by name:** `spawnSync`, `execSync`, `execFileSync` (the page's thread cannot wait),
`shell`, `uid`/`gid`, a stream or descriptor as stdio, `'ipc'` in `spawn`, a command `exec` could
run only through a shell, and a `fork` `execPath` other than the page's own.

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
