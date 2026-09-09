# ADR-0016: Synchronous file reads are permitted, and "everything is async" is narrowed to the network

- **Status:** accepted
- **Date:** 2026-09-09
- **Type:** architecture
- **Decided by:** owner

## Decision

`orivon.fs` gains a **synchronous read**, and [`capability-api.md`](../architecture/capability-api.md) design rule 2 -- *"Everything is
async"* -- is narrowed to apply to **network operations only**.

The mechanism is the runtime's synchronous renderer-to-main channel (`ipcRenderer.sendSync`),
which blocks the renderer until the reply arrives. That blocking is the required behaviour, not a
tolerated side effect.

The alternative mechanism -- `Atomics.wait` on a `SharedArrayBuffer` with app code in a Worker --
is **deferred, not rejected**, and is recorded here as the escape hatch. Both present the same
interface to an app, so switching later changes nothing an app can observe.

**Synchronous `net` remains excluded.** Rule 2's reasoning holds there and is unchanged.

## Context

[`open-questions.md`](../open-questions.md) A94. Design rule 2's stated justification is narrow: *"Node constructs
sockets synchronously; across an IPC boundary we cannot."* That is sound for a dial, which cannot
complete without a DNS round trip. It was then generalised to `fs`, where it does not follow -- a
local file read is sub-millisecond, and blocking for it is not the same cost at all.

The consequence of an async-only `fs` is not slow apps, it is **absent calls**: `readFileSync` and
`existsSync` are how Node programs read their own configuration, usually inside a dependency the
porting developer does not control. The app throws before it renders.

This is not hypothetical. The FreeTube reconnaissance ([`freetube-port-recon.md`](../planning/freetube-port-recon.md))
found `existsSync` in its own main process, and its datastore (`@seald-io/nedb`) is file-backed.
[ADR-0002](./ADR-0002-capability-api-is-the-durable-asset.md)'s bet is that Electron apps port mechanically; without this, the bet becomes "port
mechanically after auditing the dependency tree", which is a different and much weaker claim.

## Alternatives considered

**Stay async-only.** The status quo. Rejected: it fails apps at startup, at the exact point a new
user is deciding whether Orivon works.

**Route B now (`Atomics.wait` in a Worker).** Proven technology -- it is how StackBlitz
WebContainers gives Node programs synchronous `fs` in an ordinary browser tab. Deferred rather
than chosen: it decides *where app code runs*, which is a larger change than the problem currently
justifies, and it depends on cross-origin isolation headers that are ours to set under [ADR-0007](./ADR-0007-cached-bundles-served-at-their-own-origin.md)
but are **unverified in this tree**.

**Rewrite sync calls at build time.** A codemod over the app's bundle. Rejected: the calls are
usually inside dependencies, and a porting developer editing someone else's package is exactly the
friction this project exists to remove.

## Reasoning

The blocking cost is bounded and visible. A handful of configuration reads at startup is a few
milliseconds and invisible; an app that reads files constantly stutters, which is the app's fault
and is observable rather than mysterious.

Portability survives it, and [ADR-0002](./ADR-0002-capability-api-is-the-durable-asset.md) turns on portability: a WASM host makes synchronous host
calls natively, and Mojo has synchronous IPC. A synchronous `fs` is not an Electron trick that
would have to be unwound if the engine underneath changes.

Choosing the cheaper mechanism first is not a shortcut here, because **the interface is identical
under both**. Route A can be replaced by route B when a real app makes it necessary, and no app
already written will notice.

## Consequences

- The renderer blocks for the duration of each synchronous read. Accepted.
- `src/contracts/` changes, so it merges as its own PR before any implementation.
- The shim can present `readFileSync` and `existsSync`, which is what a ported app actually calls.
- Design rule 2's text must be amended where it stands, not contradicted elsewhere -- a rule that
  says two things is worse than either.
- If a real app is measurably harmed by the freeze, that is the trigger to build route B, and the
  trigger should be a measurement rather than a worry.

## Reversibility

**High as to mechanism, low as to the promise.** Swapping route A for route B is invisible to
apps. Withdrawing synchronous reads altogether would break every app that came to rely on them,
so the decision to *have* them is the load-bearing half.
