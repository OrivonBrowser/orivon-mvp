# ADR-0016: Synchronous file reads are permitted, and "everything is async" is narrowed to the network

- **Status:** accepted, **amended 2026-09-29 (see section Amendment)**
- **Date:** 2026-09-09
- **Type:** architecture
- **Decided by:** owner

## Decision

`orivon.fs` gains a **synchronous read**, and [`capability-api.md`](../architecture/capability-api.md) design rule 2, *"Everything is
async"*, is narrowed to apply to **network operations only**.

The mechanism is the runtime's synchronous renderer-to-main channel (`ipcRenderer.sendSync`),
which blocks the renderer until the reply arrives. That blocking is the required behaviour, not a
tolerated side effect.

The alternative mechanism, `Atomics.wait` on a `SharedArrayBuffer` with app code in a Worker,
is **deferred, not rejected**, and is recorded here as the escape hatch. Both present the same
interface to an app, so switching later changes nothing an app can observe.

**Synchronous `net` remains excluded.** Rule 2's reasoning holds there and is unchanged.

## Context

[`open-questions.md`](../open-questions.md) A94. Design rule 2's stated justification is narrow: *"Node constructs
sockets synchronously; across an IPC boundary we cannot."* That is sound for a dial, which cannot
complete without a DNS round trip. It was then generalised to `fs`, where it does not follow: a
local file read is sub-millisecond, and blocking for it is not the same cost at all.

The consequence of an async-only `fs` is not slow apps, it is **absent calls**: `readFileSync` and
`existsSync` are how Node programs read their own configuration, usually inside a dependency the
porting developer does not control. The app throws before it renders.

This is not hypothetical. The FreeTube reconnaissance (`orivon-ports`'s `docs/freetube-recon.md`)
found `existsSync` in its own main process, and its datastore (`@seald-io/nedb`) is file-backed.
[ADR-0002](./ADR-0002-capability-api-is-the-durable-asset.md)'s bet is that Electron apps port mechanically; without this, the bet becomes "port
mechanically after auditing the dependency tree", which is a different and much weaker claim.

## Alternatives considered

**Stay async-only.** The status quo. Rejected: it fails apps at startup, at the exact point a new
user is deciding whether Orivon works.

**Route B now (`Atomics.wait` in a Worker).** Proven technology: it is how StackBlitz
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
calls natively, and other IPC systems offer synchronous calls too. A synchronous `fs` is not an Electron trick that
would have to be unwound if the engine underneath changes.

Choosing the cheaper mechanism first is not a shortcut here, because **the interface is identical
under both**. Route A can be replaced by route B when a real app makes it necessary, and no app
already written will notice.

## Consequences

- The renderer blocks for the duration of each synchronous read. Accepted.
- `src/contracts/` changes, so it merges as its own PR before any implementation.
- The shim can present `readFileSync` and `existsSync`, which is what a ported app actually calls.
- Design rule 2's text must be amended where it stands, not contradicted elsewhere, since a rule that
  says two things is worse than either.
- If a real app is measurably harmed by the freeze, that is the trigger to build route B, and the
  trigger should be a measurement rather than a worry.

## Reversibility

**High as to mechanism, low as to the promise.** Swapping route A for route B is invisible to
apps. Withdrawing synchronous reads altogether would break every app that came to rely on them,
so the decision to *have* them is the load-bearing half.

## Amendment (2026-09-29)

**In a Worker (a forked child or a `worker_threads` thread) of a cross-origin isolated app, every
path-based `fs` `*Sync` call works**, over the shared-memory synchronous channel this ADR recorded
as route B, the deferred escape hatch. `spawnSync`, `execSync` and `execFileSync` work there too,
over a request kind of their own on the same channel. The page keeps exactly what it already had:
`readFileSync` and `existsSync`, nothing more.

The reason is the same freeze this ADR weighed, applied to where it actually lands: a page that
blocks freezes the tab, which is why design rule 2 confines synchronous calls to one narrow
exception. A Worker that blocks freezes no page -- it is not the thread anything is rendered on,
and app code already expects a Worker to be able to do this (`Atomics.wait` on a
`SharedArrayBuffer` is exactly how synchronous WebAssembly threads and tools like StackBlitz's
WebContainers give Node code a blocking `fs` in an ordinary tab). Route B was deferred, not
rejected, for wanting more than the problem then justified and for depending on cross-origin
isolation this tree had not verified; both are now true. Elsewhere -- the page, or a Worker with no
`SharedArrayBuffer` -- every one of these calls still refuses by name, since nothing there can
block without freezing something that must not freeze.

No contracts change: the Worker's synchronous twin (`Symbol.for('orivon.synchronous')`,
`src/shim/worker/orivon-client.ts`) already makes any `orivon.*` call synchronously, and
`spawnSync`'s request rides the same channel under its own registered symbol
(`Symbol.for('orivon.spawnSync')`) rather than through `src/contracts/`, exactly as this ADR's own
mechanism (`ipcRenderer.sendSync`) never appeared in the contract either.

## Amendment (2026-10-08)

**On the page, every path-based `fs` `*Sync` call works too, over the same blocking
`ipcRenderer.sendSync` channel `readFileSync` already used.** The owner decided it: Orivon's
compatibility goal is Node, not the browser, and a ported Electron app that runs Node in its window
(28 of the 80 apps in the compatibility survey) calls `mkdirSync`, `writeFileSync`, `copyFileSync` and
`statSync` at startup. WebTorrent Desktop's first start runs `mkdirSync` twice, `copyFileSync` ten
times and `readFileSync` five, and threw before it rendered. This reverses the page half of the
2026-09-29 amendment, which kept the page to `readFileSync` and `existsSync`.

The mechanism is the Worker's synchronous twin again, for `fs` only: the preload installs
`Symbol.for('orivon.synchronous')` on the page's `orivon`, holding `stat`, `readFile`, `writeFile`,
`mkdir`, `readdir`, `rm` and `rename`, and the shim's path-based `*Sync` calls run over it exactly as
they do in a Worker. The twin is a registered symbol, not part of the contract. Each call is one
`{ op, args }` message on `SYNC_CONTROL_CHANNEL`, answered by the main process synchronously and never
behind an `await`.

What does not change, and what the broker checks the same way as the async call: the grant and the path
confinement (both sides of a `rename`), the per-origin rate limit shared with `CONTROL_CHANNEL`, the
session and caller attribution (ADR-0045), the closed error codes, and `fs.quotaBytes`, which the
synchronous `writeFile`, `rm` and `rename` charge and refund on the one per-origin ledger the async
calls use (measuring the origin's files synchronously the first time it is needed). A synchronous
write is held to the same 2 MiB cap as a synchronous read, because it blocks the main process just as
long.

What stays refused on the page, by name (`ERR_ORIVON_FS_SYNC_UNSUPPORTED`): every call that holds a file
handle across calls (`openSync`, `readSync`, `writeSync`, `fstatSync`, `ftruncateSync`, `closeSync`, a
non-`'w'` flag on `writeFileSync`, `appendFileSync`), since a blocking handle would need the main
process to keep state for a caller that cannot yield; they work in a Worker of a cross-origin isolated
app. Synchronous `net` stays excluded, for the reason this ADR gave.

The cost is the one this ADR already weighed for `readFileSync`: the page blocks for the length of the
call. It is now incurred by writes as well, bounded by the size cap and the rate limit.
