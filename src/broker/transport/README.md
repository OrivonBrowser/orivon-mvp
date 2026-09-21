# `src/broker/transport/`: how a page reaches the broker, and how bytes move

**What lives here.** The Electron IPC front door, its message validation, the per-origin rate
limiter, the credit-window byte pumps that relay a socket over a dedicated `MessagePortMain`, and
`orivon.fs.readFileSync`'s synchronous sibling to all of that (`sync-fs.ts`, `sync-fs-policy.ts`,
ADR-0016): a second, `ipcMain.on`/`event.returnValue` channel
(`SYNC_CONTROL_CHANNEL`) rather than a method on `CONTROL_CHANNEL`, because it never returns a
Promise the way every `ipcMain.handle` method here does.

**What it depends on.** `electron`, [`../index.ts`](../index.ts), [`../handles/`](../handles/),
[`../adapters/`](../adapters/), [`../grants/`](../grants/), [`../policy/origin.ts`](../policy/origin.ts)
and [`src/main/`](../../main/)'s channel and registry definitions.

**What it must never import.** [`src/shim/`](../../shim/), [`src/loader/`](../../loader/),
[`src/preload/`](../../preload/) or any renderer code. This directory is the trust boundary;
importing something on the far side of it inverts the trust direction.

**Owner stream.** `broker`, build step 2.

## The two rules this directory exists to enforce

**Every call is attributed to the origin of the SENDING FRAME**, derived via
[`../policy/origin.ts`](../policy/origin.ts)'s `originFromSenderFrame`, never to anything the
renderer put in the payload (T3). A compromised renderer process can reach this channel
directly, so `method` and `payload` are validated here defensively rather than trusted because
the preload is well-behaved.

**Bytes never travel over request/response IPC.** `net.connect` returns a plain descriptor and
separately hands the frame a dedicated port; the read pump ([`port-pump.ts`](port-pump.ts)) and
the write sink ([`port-sink.ts`](port-sink.ts)) relay over that, each bounded by a credit window
so neither side can outrun the other. Per-message IPC is far too slow for torrent-rate data
([`contracts/ipc.ts`](../../contracts/ipc.ts)).

See [`../README.md`](../README.md)'s design notes for the socket-teardown rationale, which spans
this directory and [`../adapters/`](../adapters/).

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**Why `dispatch()`'s switch is split into [`dispatch-app.ts`](dispatch-app.ts),
[`dispatch-fs.ts`](dispatch-fs.ts), [`dispatch-id.ts`](dispatch-id.ts) and
[`dispatch-net.ts`](dispatch-net.ts) rather than staying inline in [`ipc.ts`](ipc.ts).**
Every new capability method adds dispatch cases, and with one inlined switch every one of them
lands in [`ipc.ts`](ipc.ts): the documented failure mode where two individually-compliant PRs
push a shared file over Rule 2's 500-line limit on merge, not on either branch. The cases group
by capability prefix (`app.*`, `fs.*`, `id.*`, `net.*`), so that grouping is the seam: each
capability's cases, and anything used by only that capability (`deliverTcpSocket`, needed only
by `net.connect`/`net.connectSecure`), live in their own file. `ipc.ts`'s own `dispatch()` is a
thin router that narrows `method` to each module's own slice of `ControlMethod`
(`Extract<ControlMethod, \`app.${string}\`>` and its three siblings) and calls straight through:
one switch, the same exhaustiveness, spread across four files. Growth lands in the one file that
needs it: a new `fs.*` method grows only `dispatch-fs.ts`, a new `net.*` method only
`dispatch-net.ts`.

**`ControlEvent` lives in [`port-transport.ts`](port-transport.ts), alongside the `PortDeliveryFrame`
it is built from.** Both `ipc.ts` (the top-level router and `handleControlRequest`) and
`dispatch-net.ts` (`deliverTcpSocket`, the `net.*` cases) need this type, and `dispatch-net.ts`
must not import `ipc.ts`, because that would cycle back through `ipc.ts`'s own import of `dispatchNet`.
`port-transport.ts` holds the shape it is built from and imports nothing from either file,
so it is the one place both can reach without a cycle. `ipc.ts` re-exports it unchanged, so nothing
importing `ControlEvent` from `'../ipc.js'` (the test suite, chiefly) needed to change.

**Why [`ipc.ts`](ipc.ts)'s dispatch functions take structural types, not `electron`'s real
ones.** `handleControlRequest`, `dispatch` and `registerBrokerIpc` take a `Broker` and
structurally-typed `event`/`ipcMain`/`PortTransport`, so `ipc.test.ts` exercises the whole
control-channel logic under plain Node/vitest with no Electron process running, the same
pattern [`src/main/registry.ts`](../../main/registry.ts) uses. Only `brokerIpcSubsystem`, which
nothing in that test file calls, touches the real `ipcMain`/`MessageChannelMain` value imports;
importing `electron` at module scope is still safe outside a real Electron process (it resolves
to a harmless string, so destructuring a value from it yields `undefined`, which only breaks if
actually called).

**The per-origin call-rate limit (`CONTROL_RATE_LIMIT_CAPACITY`/`_REFILL_PER_SECOND` in
[`ipc.ts`](ipc.ts)) is provisional (open-questions.md A38).**
Before it existed, HandleTable's in-flight cap did nothing to stop `app.grants()`, which has no
handle, grant, or I/O to scope, and 5,000 concurrent calls to it were all answered in full. The
chosen numbers cut that to roughly 200 admitted calls, sized against that attack and against an
app polling `app.grants()` to react to a live revocation. The limit is shared across all eight
control methods deliberately: `fs`/`net` dispatch is real I/O with no measured call-rate data
either, so a tighter, method-specific limit risks `'limit'` becoming a routine error for a busy
app before any evidence justifies it. This leaves a fairness risk A38 names but does not solve: a
burst of small file reads could still starve an unrelated `app.grants()` poll once `fs`/`net` see
real traffic. `registerSyncFsIpc` shares this SAME limiter instance rather than a second one, so
`fs.readFileSync` cannot be used to dodge it by moving traffic to a channel with no budget of its
own.

**`sync-fs.ts`/`sync-fs-policy.ts` reuse `../index.ts`'s own `Broker.fs.confineSync`**, ADR-0016's
synchronous grant-check/confinement entry point, built entirely from
`confineForOrigin`'s existing logic (`../index.ts`'s own doc), so a missing grant or a
traversal/symlink escape is refused by the SAME check `fs.readFile`/`writeFile` use, never a
second implementation of it (code-guidelines.md Rule 3). `sync-fs-policy.ts`'s
`createSyncFsPolicy` is a thin pass-through onto that method plus `node:fs`'s own `readFileSync`
for the raw disk I/O, which the async `BrokerFs.readFile` adapter has no synchronous counterpart
for. **Deliberately
outside the per-origin in-flight budget (`HandleTable.run`) `readFile`/`writeFile` run under** --
that budget is `async`-shaped by construction and a synchronous IPC reply cannot await a slot
becoming free, so this is a genuinely open design question, not merely a deferred one; see
`../index.ts`'s own doc on `confineSync` and `open-questions.md`.

**`sync-fs-policy.ts`'s `readFileSync` copies before returning, for the same reason
[`../adapters/node-fs-adapter.ts`](../adapters/node-fs-adapter.ts)'s `readFile` does**; see
`../adapters/README.md`'s Design notes for the structured-clone/pooled-buffer rationale. Being
synchronous does not exempt this path from it: `node:fs`'s `readFileSync` pools small allocations
exactly like its promise-based sibling, so a raw pass-through here would hand the page whatever
else shares the pool slab. No shared helper: the copy is `new Uint8Array(x)`, a single builtin
call, and the two sites live in different layers of the trust boundary (`transport/` depends on
`adapters/`, never the reverse): a named wrapper for one expression would be indirection without
reducing what either call site has to get right.
