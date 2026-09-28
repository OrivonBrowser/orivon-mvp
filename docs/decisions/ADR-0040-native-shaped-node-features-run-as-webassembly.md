# ADR-0040: Native modules and child processes run as WebAssembly in the app's tab, never as machine code

- **Status:** accepted, **amended 2026-09-28**: `spawn`, `fork` and the addon resolution are built (see the Amendments at the end)
- **Date:** 2026-09-28
- **Type:** architecture / security
- **Decided by:** owner (the goal, and that it must keep every broker guard with no added risk);
  AI recommendation accepted (the mechanism)

## Decision

A ported app gets native modules, `child_process.spawn` and `child_process.fork` only in forms
where every system call its code makes is an `orivon.*` call under that app's own grants:

- **A native addon is loaded as its WebAssembly build**, resolved when the app's code requires
  the `.node` file: a napi-rs `wasm32-wasi` package, or the addon rebuilt with emnapi. An addon
  with no WebAssembly build refuses by name, naming its substitute (`compatibility-matrix.md`
  Table 5).
- **`spawn` runs a WASI program the app ships** in its pinned bundle. A native binary refuses by
  name.
- **`fork` runs the app's module in a Web Worker**, with the Node shim and an `orivon.*` proxy,
  its `send`/`'message'` channel over `postMessage`.

This build never runs machine code on an app's behalf, never starts an operating-system process
for one, and offers no grant that means "everything this computer's user can do". The
`subprocess` capability stays excluded (`security-model.md`). Reversing that for a later build
would take a new ADR; the vision's own answer to an app needing operating-system power is also
WebAssembly under WASI (`orivon-runtime`), so nothing in it points the other way.

The foundation lands with this ADR: a WASI preview1 host over `orivon.fs` in `src/shim/wasi/`,
and Node's `wasi` module over it. A WASI call is synchronous for the program and `orivon.fs` is
asynchronous; the host suspends the program on each file call through WebAssembly JavaScript
Promise Integration (JSPI). `spawn` and `fork` run their children in Web Workers
(`src/shim/child-process/`, `src/shim/worker/`), and an addon loads as its WebAssembly build
through emnapi (`src/shim/addon/`).

## Context

The owner set the goal on 2026-09-28: native modules loaded on the fly, and `child_process.spawn`
and `fork`, as ported Electron apps use them. Asked how native code should be contained, the owner
answered that it must always have the same broker allowance as any app, with zero added risk.

Two explorations written the same day,
[`child-process-design.md`](../planning/child-process-design.md) and
[`wasm-compatibility.md`](../planning/wasm-compatibility.md), measured the mechanism in this
tree's Electron 44 (Chromium 152): JSPI works in an app tab's renderer, on the main thread and in
a dedicated Worker, at about a microsecond per suspending call, with no cross-origin isolation.

`security-model.md` requires an ADR before anything called a subprocess exists. This is that ADR,
and it keeps the exclusion.

## Alternatives considered

**A Node process per app, with a full-access grant.** Electron's `utilityProcess` runs real
Node, which loads native addons and spawns and forks children. Rejected by the owner: for an app
holding the grant the broker bounds nothing (file confinement T1, quota T11, resolved-address
matching T12, CSP T22), one click on a URL's consent hands over the machine, and a host that
controls an app's updates would control the machine.

**An operating-system sandbox around native code.** A sandbox can allow or deny a system call, but
it cannot apply Orivon's rules: host patterns checked against the resolved address, the
private-range refusal, quota, revoking a grant mid-run. Applying them needs system-call
interception. On Linux that is seccomp user notification, which needs native code in Orivon (Rule
8, `ADR-0002`). Windows has no equivalent without a driver, and macOS profiles filter paths and IP
addresses only. Electron's `utilityProcess` has no sandbox option (`electron.d.ts`,
`ForkOptions`). Even a perfect sandbox leaves native code talking straight to the kernel.

**A WASI host in a utility process** (`child-process-design.md` section 7). WebAssembly would be
compiled by V8 in an unsandboxed Node with the user's authority behind it, and Node's WASI writes
to disk without the broker's quota counter.

**A worker blocked on `Atomics.wait` for synchronous calls** (`A94`'s Route B). It needs
`SharedArrayBuffer`, so cross-origin isolation for every program. JSPI gives the same synchrony
with neither.

**An x86 emulator compiled to WebAssembly**, so real binaries run fully brokered. It runs Linux
binaries only, and many times slower. It is research, not a plan.

## Reasoning

Every system call of the program is an `orivon.*` call the app's JavaScript could already make,
so every existing guard applies with no new line of policy code; `child-process-design.md`
section 6 walks the guards one by one. WebAssembly runs wherever Chromium runs, so the same shape
serves every platform, which a native process cannot on Windows under Rule 8 or at all on Android.
It is the vision's own answer to "an app needs operating-system power" (`orivon-runtime`, WASI),
reached inside the renderer instead of in a separate host.

## Consequences

- **An addon with no WebAssembly build does not run.** None of the native addons the current
  ports use (Seshat in Element, `node-hid` and `usb` in ASGARDEX, `pkcs11js`) publishes one; their
  route stays substitution, or WebHID and WebUSB for the device ones. The addon resolution is
  therefore built for the first app whose addon has a WebAssembly build.
- **A native binary refuses.** Daemon apps whose daemon is native, among them every Go one
  (kubo, lnd, geth: Go cannot open sockets from any WebAssembly target), do not run their daemon.
- **A program run through `node:wasi` holds the page's main thread while it computes**, as
  WebAssembly the app calls itself already does. One run through `spawn` is in a Worker.
- **The host serves no links, no file times and no sockets.** `orivon.fs` has no links and no way
  to set times; preview1 cannot dial. Against the preview1 conformance suite
  (`WebAssembly/wasi-testsuite`), 63 of 72 programs pass, and the nine that fail need links or
  file times. Sockets come with WASI 0.2 over `orivon.net`, for a named program.
- **This build's WASI host needs JSPI.** An engine beneath the API without it would need another
  synchrony mechanism, such as Route B, for the same app-facing shape. `new WASI()` refuses by
  name on an engine without JSPI.
- **Node's `WASI.start()` returns a promise here**, and `preopens` name paths under the app's
  virtual root: a documented departure, since a program suspends on each file call and an app tab
  has no host paths.

## Reversibility

- **Cost to reverse:** moderate. The WASI host and `wasi` module can be withdrawn cheaply until
  a port ships against them. Reversing the exclusion of native code is a new ADR, which would start
  from `child-process-design.md` section 8's checklist.
- **What would make us revisit:** an app the success metric needs whose native code has no
  WebAssembly build and no substitute, or a class of WebAssembly exploit the renderer sandbox and
  the grant model cannot bound (`ADR-0036`'s own trigger).

## Amendment (2026-09-28): `spawn` and `fork` are built

`child_process` now runs every child in a Web Worker: `spawn` a WASI program from the app's bundle,
`fork` an app module with an IPC channel, each reaching `orivon.*` through the page. The Decision
and Consequences above are rewritten to say so. The addon resolution is decided (`d-0155`) and not
built yet.

## Amendment (2026-09-28): the addon resolution is built

`process.dlopen` and `module.createRequire` load a `.node` path's WebAssembly build through
emnapi, over the WASI host's synchronous imports. An addon cannot yet reach files or sockets, and
a threaded build refuses by name. The Decision above is rewritten to say so.

