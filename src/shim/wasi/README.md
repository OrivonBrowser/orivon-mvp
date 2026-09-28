# `src/shim/wasi/`: a WASI host over `orivon.fs`

**What lives here.** A host for WebAssembly programs that import `wasi_snapshot_preview1` instead
of calling JavaScript (`wasm32-wasip1`), and `node-wasi.ts`, Node's `WASI` class over it, the
`wasi` row of [`../module-map.ts`](../module-map.ts). Every file call a program makes is an
`orivon.fs` call under its app's grants: the host adds errno translation and a descriptor table,
never authority ([`ADR-0040`](../../../docs/decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)).
Durable: it depends on no Electron API, only on JSPI, which Chromium ships from version 137.

**What it depends on.** [`../../contracts/`](../../contracts/), and within the shim
`fs/paths.ts` and `fs/root.ts` (so a Node program and a WASI program in one app see the same
files), `orivon-global.ts`, `node-errors.ts`, `errors.ts` and `polyfills/module-proxy.ts`.

**What it must never import.** `electron`, or [`../../broker/`](../../broker/): see the parent
README. The host reaches files only through the `WasiFs` it is handed.

**Owner stream.** `shim`.

**Not served:** links and file times (`orivon.fs` has neither), sockets (preview1 cannot dial),
and listing the app root itself, which the broker refuses as it does for `fs/`. Against the
preview1 conformance suite, 63 of 72 programs pass; the nine that fail need links or file times.
[`tests/conformance.test.ts`](tests/conformance.test.ts) runs it when `ORIVON_WASI_TESTSUITE`
names a checkout.

## Design notes

**Only imports that may await are wrapped in `WebAssembly.Suspending`** (`instantiate.ts`, the
one file that touches JSPI). Chromium refuses a `Suspending` import reached through an export not
wrapped in `promising`, and never calls it, so clocks, randomness, arguments and `proc_exit` stay
plain imports in each family's `sync` half. Moving one to `async` breaks every module whose
exports JavaScript calls directly.

**Never hold a view of guest memory across an `await`.** While a program is suspended another
export may grow its memory, which detaches the buffer. `memory.ts` builds a fresh view on each
access, and reads every pointer through `unsigned()`: an i32 above 2 GiB reaches JavaScript
negative.

**`errnoFor` prefers the broker's `platformCode`**: it is the one place `ENOTEMPTY`, `EISDIR` and
`ENOTDIR` survive. A `denied` carries none, so every denial is `EACCES`, uniform as the broker
keeps it. An error with no errno shape is a bug in the host and is rethrown, never turned into a
plausible `EIO`.

**A revoked grant terminates the program; a bare `limit` is retried** three times before it is
`ENOSPC` (`context.ts`). A program retrying against a root that no longer exists would spin, and
the in-flight cap clears on its own while a program has no code path for `EAGAIN` on a file.

**Rights are reported per descriptor kind, never enforced**, since programs read them; the broker
is the boundary, so `fd_fdstat_set_rights` answers `NOTSUP`, as current runtimes do. The
synchronous-write fdflags are refused rather than accepted and not honoured.
