# ADR-0014: The `window.orivon` net surface depends on `executeInMainWorld`, an experimental Electron API

- **Status:** accepted
- **Date:** 2026-09-06
- **Type:** architecture
- **Decided by:** owner (`d-0020`)

## Decision

`window.orivon`'s `net` capability surface — the `TcpSocket`/`TcpServer`/`UdpSocket` handles
`ADR-0008` specifies as WHATWG streams — is built using `contextBridge.executeInMainWorld`,
which Electron's own type definitions mark `@experimental`
(`node_modules/electron/electron.d.ts`, verified against electron 44.0.0 in this tree):

```
7224-     * A copy of the resulting value from executing the function in the main world.
7225-     * Refer to the table on how values are copied between worlds.
7226-     *
7227-     * @experimental
7228-     */
7229:    executeInMainWorld(executionScript: ExecutionScript): any;
```

Orivon accepts this dependency on an experimental Electron API, formally, rather than treating
it as an implementation detail buried in a PR body — per `CLAUDE.md` Rule 1 ("do not silently
promote assumptions into architecture... if a choice is load-bearing and reversible only at
cost, write an ADR"). It is exactly that kind of choice: if a future Electron release changes or
removes `executeInMainWorld` with no replacement, every app's `orivon.net.*` calls stop working
at once, and the fix is a broker-side rewrite, not a config flag.

Built by `stream/broker-24-preload-net-surface` (PR #81, merged), which this ADR formalises.

## Context

A `ReadableStream`/`WritableStream` built in the preload's isolated world and exposed via the
ordinary `contextBridge.exposeInMainWorld(...)` does not survive the crossing intact. Electron's
own documentation states the copy semantics plainly: *"Function values are proxied, while other
data types are copied and frozen."* A `ReadableStream` is not a function — it is copied as plain
data, which strips its prototype and methods. The page would receive an inert, frozen object
that merely looks like a stream, not something `new Response(x).body` or a `for await` loop can
use. `ADR-0008`'s whole reason for choosing streams as the durable handle shape — native
backpressure, no WASM-incompatible primitives, no bearer-capability port handed to the page — is
worthless if what actually reaches `window.orivon.net` is a dead copy.

The stream object therefore has to be **constructed in the main world**, over closures that
*are* correctly proxied (functions survive the crossing as live references, per the same
Electron behaviour quoted above). `executeInMainWorld` is the only Electron mechanism that runs
preload-authored code inside the main world's own global scope, with access to arguments passed
through `args` (themselves proxied correctly) and to callbacks threaded back out through them.
The older, non-experimental `exposeInMainWorld` only ever installs values *onto* the main
world's `window` object from the isolated world — it does not execute a function *as* the main
world, so nothing built through it ever runs with the main world's own `ReadableStream`
constructor. That distinction is the entire reason this ADR exists: it is not a preference for a
newer API, it is the only API in Electron's surface that does the specific thing needed here.

**Verified live, not assumed**, via a throwaway sandboxed preload + fixture window
(`.claude/skills/orivon-electron/`'s launch pattern, which strips `ELECTRON_RUN_AS_NODE` and
confirms a real window attached before trusting any result). The pre-flight probe confirmed,
in a **sandboxed** preload (`sandbox: true`, the same posture every real Orivon preload runs
under):

1. `executeInMainWorld` exists and is callable from a sandboxed preload.
2. A function passed through `args` is correctly proxied — calling it from main-world code
   invokes the real isolated-world function, not a dead copy.
3. A callback passed *back* through that function (isolated world → main world → back to
   isolated world) is itself correctly proxied — the round trip works, not just one direction.
4. The object produced in the main world is a **real, normally-behaving main-world
   `ReadableStream`** — `instanceof ReadableStream` true against the main world's own global,
   `.getReader()`, `.pipeThrough()` and ordinary consumption all work exactly as they would for
   a stream the page constructed itself.

## Alternatives considered

**`webFrame.executeJavaScript` over a hidden bridge.** Also runs code in the main world from a
preload, and was considered for exactly that reason. Rejected: `webFrame.executeJavaScript` is
reachable *by the page itself*, not only by the preload — it is a method on `webFrame`, which
page-level script can call directly once it holds a reference to it, unlike `executeInMainWorld`
which only the preload (via `contextBridge`) can invoke. That reachability difference is not
cosmetic here. The write-direction backpressure mechanism PR #81 builds alongside this surface
(the write-window byte cap bounding how much unacknowledged data one socket may buffer in the
broker before the app's `write()` calls start blocking — 256 KiB per socket, the write-side
sibling of the read-direction credit window `handle-contracts.md` §Backpressure already
specifies, and the mechanism `security-model.md` T11b names as the general defence against one
origin exhausting broker memory) depends on the app's own code being unable to bypass the
closures that enforce it. A hidden bridge built over `webFrame.executeJavaScript` cannot make
that guarantee — a hostile page that can reach the same main-world execution path the bridge
uses can construct its own unthrottled writes against the underlying port, turning the write
cap from a **structural** limit (the only path to the socket runs through code that enforces the
cap) into an **advisory** one (the cap applies only to well-behaved callers who go through the
intended path). That downgrade defeats the exact property `writeWindowBytes` exists to
guarantee, so this alternative was not built.

**Do nothing; ship `net` without a real stream, or degrade to a callback-based non-stream API.**
Not seriously considered as a final shape — `ADR-0008` already settled that handles are WHATWG
streams, and reopening that would need its own ADR reversal, not a workaround buried in this
one. Named here only because it is the shape of what fail-closed produces if
`executeInMainWorld` ever stops working (see §Consequences) — the point being that this ADR
chooses that outcome deliberately, in advance, rather than something worse happening by
accident later.

## Reasoning

Given that a real main-world stream requires main-world *construction*, and only
`executeInMainWorld` executes preload-authored code as the main world while still proxying
functions and callbacks correctly, the experimental-API dependency is not a shortcut chosen
over a safer alternative — it is the only mechanism in Electron's current surface that satisfies
both requirements `ADR-0008` already imposes (real stream semantics, no bearer-capability port
handed to the page). The live pre-flight probe existed specifically to convert "the docs imply
this works" into "this was actually exercised, sandboxed, both directions, and produced a real
`ReadableStream`" before committing to it architecturally.

**This does not contradict `ADR-0002`.** `ADR-0002`'s own load-bearing claim is that the
*durable* asset is the `orivon.*` API shape, and the *Electron mechanism underneath it* is
explicitly disposable — "a shortcut in `src/main/` costs a refactor of code that was replaceable
anyway" (`CLAUDE.md` §The load-bearing idea). Depending on an experimental Electron API to
deliver a stable, unchanging `window.orivon.net` surface is exactly that tradeoff, not an
exception to it: apps written against `orivon.net.connect(...)` see no difference at all if
`executeInMainWorld` is ever replaced by some other main-world-construction mechanism, because
nothing about the `orivon.*` shape depends on how the stream was built underneath it. The
fail-closed design in §Consequences below is what makes that true under failure, not just under
normal operation — it protects the durability guarantee `ADR-0002` already made, rather than
weakening it.

## Consequences

- **Fail closed, not degraded.** If `executeInMainWorld` is ever removed, disabled, or changed
  in a way that breaks this construction, the page gets **no `window.orivon.net` at all** — no
  networking capability, cleanly absent — rather than a partially-working substitute (an
  `EventEmitter`-shaped fallback, a non-stream callback API, or a stream missing backpressure).
  This was a deliberate choice over the alternative of silently degrading: a broken-looking
  `net` surface that sometimes drops data or never backpressures would look like an app bug or a
  security regression to any developer or user who hit it, and would be far harder to diagnose
  than an absent capability with a clear, loud failure at startup. Fail-closed converts
  "mysterious, possibly-exploitable partial breakage" into "an obviously missing feature,"
  which is safer and cheaper to notice.
- Every app's `orivon.net.*` calls become dependent, transitively, on Electron continuing to
  ship `executeInMainWorld` in some working form. This is stated openly rather than hidden
  behind the `@experimental` tag going unread — it is the actual risk this ADR exists to record.
- `src/preload/orivon-surface.ts`, `socket-bridge.ts`, `socket-port.ts` and
  `main-world-socket.ts` (the `broker` stream's preload surface, `docs/development/
  parallel-work.md`'s ownership map) are the code this decision governs.
- No change to `ADR-0008`'s handle shape, `handle-contracts.md`'s wire protocol, or
  `security-model.md`'s T17 mitigation (the raw port still never crosses into the main world;
  only the stream *object*, built over already-proxied closures, does). This ADR is about which
  Electron primitive constructs the stream, not about what crosses the trust boundary.

## Reversibility

- **Cost to reverse:** expensive while `executeInMainWorld` remains the only Electron mechanism
  that both executes as the main world and proxies functions/callbacks correctly across it —
  there is no drop-in substitute today. If Electron ever ships a stable, non-experimental
  equivalent, swapping to it is cheap (the `orivon.*` surface itself does not change, only the
  preload-internal construction, per `ADR-0002`'s reasoning above). Absent that, reversing this
  decision means either reopening `ADR-0008`'s stream-shape decision or building a materially
  weaker capability (see the rejected alternatives above) — a one-way door in practice, not by
  design choice but because no better path currently exists in the platform.
- **What would make us revisit:** (1) Electron deprecates or breaks `executeInMainWorld` without
  shipping a working replacement — at which point the fail-closed behaviour in §Consequences is
  already the live, observed outcome, and this ADR's job becomes finding or building the
  replacement; (2) `webFrame.executeJavaScript`'s backpressure weakness (§Alternatives) is found
  to be exploitable in practice against the rejected-alternative design, which would mean this
  ADR's own reasoning for preferring `executeInMainWorld` was insufficiently cautious and needs
  re-examining; (3) Electron promotes `executeInMainWorld` out of `@experimental` — not a reason
  to change anything, but the point at which this ADR's central risk (§Decision, §Consequences)
  is resolved and the document should say so.
