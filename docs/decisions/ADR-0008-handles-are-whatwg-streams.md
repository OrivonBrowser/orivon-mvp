# ADR-0008: Capability handles are WHATWG streams, not EventEmitters or raw ports

- **Status:** accepted
- **Date:** 2026-08-25 (decided) / 2026-08-26 (recorded)
- **Type:** architecture
- **Decided by:** owner

## Decision

The durable shape underneath every Orivon capability handle (`TcpSocket`, `TcpServer`,
`UdpSocket`, `FileHandle`) is a **WHATWG stream** (`ReadableStream`/`WritableStream`), not a
Node-style `EventEmitter` and not a raw `MessagePortMain` handed to app code. Node's own
shapes are still what an app sees, but only because `orivon-node-shim` reconstructs them on
top of this layer — the streams interface is what survives into `handle-contracts.md`, and
what every future engine (Wasmtime, a Chromium/Mojo fork) must be able to implement under.

## Context

`capability-api.md`'s v0 surface named five handle types and left their shape unspecified —
tracked as `open-questions.md` A10. Gate 0 of the week-0 spike (`spike-verdict.md`) resolved
the one open technical fact this decision depended on: transferable `ArrayBuffer`s do not
work renderer→main over `MessagePortMain` ([electron#34905](
https://github.com/electron/electron/issues/34905), reproduced and found worse than
reported — the message is silently dropped, not merely slow) and structured clone alone
measures 313–1134 MB/s, 60–200x past the 1–5 MB/s product requirement. With that settled, the
owner made this decision on 2026-08-25, ahead of A10's full specification being written.

## Alternatives considered

**`EventEmitter`, mirroring Node's `net.Socket`/`dgram.Socket` directly at every layer.**
Closest to "just port the Node code" and the option design rule 1 originally implied
project-wide. Rejected: `EventEmitter` has no backpressure primitive. A `'data'` event fires
whether or not the listener is ready, so the only way to avoid unbounded renderer memory
growth under a fast swarm is to hand-roll flow control on top of an abstraction that was not
built for it — which is exactly the ad hoc, per-shim reinvention design rule 6 ("prefer
mature components... do not reinvent without a written reason") exists to avoid. Streams
solve this natively via `highWaterMark` and `pull()`.

**A raw `MessagePortMain` per handle, transferred to the app.** Fastest possible path,
structurally — no broker-side stream wrapping at all. Rejected for two independent reasons,
either alone sufficient: (1) `MessagePort` has no WASM equivalent, so any code written
against it stops being portable the moment the Wasmtime leg (`docs/decisions/`, the
Node-broker-now/Wasmtime-later/Chromium-later roadmap) is built, which is precisely the kind
of dead end Rule 5 forbids; (2) a transferred port carries no sender identity
(`security-model.md` T17) — handing one to app code makes it a bearer capability, so any
origin that gets hold of the port object can act with the capability regardless of which
origin the broker meant to authorise. `capability-api.md` design rule 3 already forbids
transferable handles for this reason; this alternative would have violated it directly.

**Recommended and decided: WHATWG streams as the durable interface.** `ReadableStream` and
`WritableStream` are available in every target (a browser renderer today, WASI's own stream
model later, Mojo data pipes are stream-shaped already), have backpressure built into their
contract (`highWaterMark`, `pull()`, `write()` resolving only on acceptance), and are not
transferable across `contextBridge` in a way that leaks sender identity — the broker holds
the raw port, the app only ever sees a stream backed by `contextBridge` closures.

## Reasoning

Two failure modes rule out the alternatives independently, and streams are the one shape that
avoids both simultaneously: `EventEmitter` fails on backpressure, raw `MessagePortMain` fails
on both WASM portability and bearer-capability leakage. Streams cost one thing —
`orivon-node-shim` must now do real reconstruction work to present Node's familiar
`Duplex`/`EventEmitter` shapes on top, rather than a thin pass-through — which is accepted
because that reconstruction cost is paid once, in one component, rather than by every future
engine backend or by every app author working around a leaky abstraction.

## Consequences

- `capability-api.md` design rule 1 ("mirror Node's API shapes") is **rescoped, not
  reversed** — it now applies to `orivon-node-shim`'s output, not to the capability layer
  itself. The capability layer's actual durable shape is what this ADR states. See the
  correction recorded in `capability-api.md` §Design rules.
- `handle-contracts.md` is the full specification built on this decision: the credit-window
  backpressure design, the close/half-close semantics keyed off `readable`/`writable`
  lifecycle, and the derived-handle-as-child-stream model for `TcpServer.connections` all
  follow directly from choosing streams here.
- `orivon-node-shim`'s job grows: every Node-shaped entry point (`net.Socket`, `dgram.Socket`,
  `fs.promises.FileHandle`) is now a wrapper reconstructed from a stream pair plus captured
  synchronous properties, not a renamed pass-through. This is accounted for in
  `handle-contracts.md` §What the shim must do.

## Reversibility

- **Cost to reverse:** one-way door once a first real app is written against
  `handle-contracts.md`. Before that point, changing `orivonApiVersion: 0`'s shape is
  explicitly permitted (`capability-api.md`, top-of-document status note).
- **What would make us revisit:** WHATWG streams turning out not to be implementable, at
  acceptable cost, on the Wasmtime host-function boundary when that work actually starts —
  the premise this decision is staked on, currently unverified because Wasmtime is deferred
  post-MVP. Record any such finding in `open-questions.md`, not silently.
