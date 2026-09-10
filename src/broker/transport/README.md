# `src/broker/transport/` — how a page reaches the broker, and how bytes move

**What lives here.** The Electron IPC front door, its message validation, the per-origin rate
limiter, the credit-window byte pumps that relay a socket over a dedicated `MessagePortMain`, and
`orivon.fs.readFileSync`'s synchronous sibling to all of that (`sync-fs.ts`, `sync-fs-grants.ts`,
`sync-fs-policy.ts`, ADR-0016) — a second, `ipcMain.on`/`event.returnValue` channel
(`SYNC_CONTROL_CHANNEL`) rather than a method on `CONTROL_CHANNEL`, because it never returns a
Promise the way every `ipcMain.handle` method here does.

**What it depends on.** `electron`, [`../index.ts`](../index.ts), [`../handles/`](../handles/),
[`../adapters/`](../adapters/), [`../grants/`](../grants/), [`../policy/origin.ts`](../policy/origin.ts)
and [`src/main/`](../../main/)'s channel and registry definitions.

**What it must never import.** [`src/shim/`](../../shim/), [`src/loader/`](../../loader/),
[`src/preload/`](../../preload/) or any renderer code. This directory is the trust boundary;
importing something on the far side of it inverts the trust direction.

**Owner stream.** `broker` — build step 2.

## The two rules this directory exists to enforce

**Every call is attributed to the origin of the SENDING FRAME**, derived via
[`../policy/origin.ts`](../policy/origin.ts)'s `originFromSenderFrame` — never to anything the
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

**Why [`ipc.ts`](ipc.ts)'s dispatch functions take structural types, not `electron`'s real
ones.** `handleControlRequest`, `dispatch` and `registerBrokerIpc` take a `Broker` and
structurally-typed `event`/`ipcMain`/`PortTransport`, so `ipc.test.ts` exercises the whole
control-channel logic under plain Node/vitest with no Electron process running — the same
pattern [`src/main/registry.ts`](../../main/registry.ts) uses. Only `brokerIpcSubsystem`, which
nothing in that test file calls, touches the real `ipcMain`/`MessageChannelMain` value imports;
importing `electron` at module scope is still safe outside a real Electron process (it resolves
to a harmless string, so destructuring a value from it yields `undefined`, which only breaks if
actually called).

**The per-origin call-rate limit (`CONTROL_RATE_LIMIT_CAPACITY`/`_REFILL_PER_SECOND` in
[`ipc.ts`](ipc.ts)) is an AI recommendation (open-questions.md A38), not an owner decision.**
Before it existed, HandleTable's in-flight cap did nothing to stop `app.grants()` — it has no
handle, grant, or I/O to scope — and 5,000 concurrent calls to it were all answered in full. The
chosen numbers cut that to roughly 200 admitted calls, sized against that attack and against an
app polling `app.grants()` to react to a live revocation. The limit is shared across all eight
control methods deliberately: `fs`/`net` dispatch is real I/O with no measured call-rate data
either, so a tighter, method-specific limit risks `'limit'` becoming a routine error for a busy
app before any evidence justifies it. This leaves a fairness risk A38 names but does not solve: a
burst of small file reads could still starve an unrelated `app.grants()` poll once `fs`/`net` see
real traffic. `registerSyncFsIpc` shares this SAME limiter instance rather than a second one, so
`fs.readFileSync` cannot be used to dodge it by moving traffic to a channel with no budget of its
own.

**`sync-fs.ts`/`sync-fs-grants.ts`/`sync-fs-policy.ts` exist because `../index.ts`'s own
`confineForOrigin` (the grant check plus path confinement `fs.readFile`/`writeFile` share) has no
exported hook, and `../index.ts` was a concurrently-edited, unmergeable file when this landed
(`stream/broker-37-secure-connect`, `docs/development/parallel-work.md`) — see `sync-fs.ts`'s own
header.** `sync-fs-policy.ts` reuses `../policy/paths.ts`'s `confinePath` directly (zero
duplication: it is the exact function `confineForOrigin` calls) and reads real bytes via
`node:fs`'s own `readFileSync`, since the async `BrokerFs.readFile` this directory's `deps.fs`
already builds has no synchronous counterpart to reuse either. The one piece that could not be
reused by import is `GrantLedger.currentGrant` — private inside `../index.ts`'s closure — so
`sync-fs-grants.ts`'s `wrapBrokerForSyncFsGrants` mirrors "does this origin hold a live `fs`
grant" from `Broker.grant`/`revoke`'s own already-public, already-resolved return values instead;
that file's header has the full argument for why this is a safe passive mirror rather than a
second, independently-decided source of grant truth. **The intended fix, once the concurrent lane
merges, is a small additive method on `Broker` (or on `../index.ts`'s private
`confineForOrigin`, exported) that this mirror can then be deleted in favour of** — flagged in
this lane's own PR body, not filed here as a fresh A-number.
