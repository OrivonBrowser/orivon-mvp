# `src/shim/addon/`: native addons as WebAssembly

**What lives here.** How ported code's native addons load: `process.dlopen` (installed on the
shim's `process` when this module loads) and the `module` target's `createRequire`
([`../polyfills/module.ts`](../polyfills/module.ts)) take a `.node` path and load that addon's
WebAssembly build through emnapi, Node-API for WebAssembly, over the WASI host's synchronous
imports. The `.node` file itself is never fetched: machine code does not run here
([`ADR-0040`](../../../docs/decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)).
Durable: no Electron API.

**What it depends on.** `@emnapi/core` and `@emnapi/runtime`, [`../wasi/`](../wasi/),
`../worker/sync-channel.ts` (the symbol a Worker's synchronous `orivon` sits under),
`../errors.ts` and `../virtual-root.ts`.

**What it must never import.** `electron`, or [`../../broker/`](../../broker/): see the parent
README.

**Owner stream.** `shim`.

**Where a build is looked for** (`resolve.ts`): beside the `.node` path on the app's origin, as
`<file>.node.wasm`, `<file>.wasm` (emnapi) or `<file>.wasm32-wasi.wasm` (napi-rs). None found is
`ERR_DLOPEN_FAILED` with `reason: 'excluded'`, naming the three paths.

**Where an addon reaches files:** in a forked child of a cross-origin isolated app (manifest
`crossOriginIsolated: true`), where each file call blocks on the page's `orivon.fs`
([`../worker/`](../worker/)'s synchronous calls). On a page's main thread, which may not block,
they refuse with `NOSYS` and one console line: an addon that needs files is loaded in a forked
child.

**What an addon cannot do yet:** run a threaded build (`wasm32-wasip1-threads` refuses by name,
`not-built`), or open sockets. A command build, one exporting `_start`, refuses too: emnapi starts
one through Node's own WASI internals, so an addon is built as a reactor, as napi-rs builds it.
Its stdout and stderr go to `process.stdout` and `process.stderr`, as Node's do: the page console,
or a forked child's pipes.

## Design notes

**Loading is synchronous, because Node's is**: `fetchSync` uses a synchronous request (a
document may not set `responseType` on one, so it reads the bytes as `x-user-defined` text) and
`new WebAssembly.Module`. A page's main thread refuses to compile a module over 8 MB that way
(measured in the e2e): `preloadAddon(filename)` fetches, compiles and instantiates it
asynchronously first, and the later synchronous load returns the cached exports. A forked child
runs in a Worker, which has no such limit, so it loads any addon on the fly.

**An addon's imports never suspend** (`../wasi/drivers.ts`'s synchronous driver): JavaScript calls
its exports synchronously, and a `Suspending` import reached without a `promising` entry traps.

**Each addon is loaded once per page or Worker**, keyed by its path on the origin however it was
spelled (a path, an https or `file:` URL, `.` segments), as Node caches a dlopen by resolved path.
Concurrent preloads share one load, and a preload that finishes after a synchronous load keeps the
first instance.
