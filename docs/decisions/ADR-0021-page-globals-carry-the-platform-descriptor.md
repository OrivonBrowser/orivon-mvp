# ADR-0021: A page global Orivon installs carries the platform's own property descriptor

- **Status:** accepted
- **Date:** 2026-09-22
- **Type:** architecture
- **Decided by:** owner

## Decision

Every global Orivon installs into an app's main world that stands in for a platform or Node
global carries that platform's own property descriptor: `writable`, `configurable` and
`enumerable` as the platform sets them. An app can replace, wrap or shadow one exactly as it
could in a browser. `window.orivon`, which Orivon invents rather than borrows, is the one
exception and stays locked.

`npm run check:page-globals` enforces it mechanically, and an exemption needs a written reason.

## Context

A routed `fetch` installed as `{ writable: false, configurable: false }` kills a whole class of
app. Strict mode forbids creating an own property that shadows a **non-writable inherited** data
property, and an ES module is always strict. The surrogate-global pattern common to `fetch`
ponyfills — a constructor whose `prototype` is the window, assigning `this.fetch` on the
instance — therefore throws `Cannot assign to read only property 'fetch'` while the app's module
graph is still evaluating. The bundle dies before it renders, and nothing names a cause.

Measured against the finished ASGARDEX port: every asset loaded `200`, the bridge installed all
fourteen globals and sixty-nine members, and `#root` stayed empty. In a bare Electron window,
where `fetch` keeps the platform's descriptor, the same bytes create a wallet and reach a
dashboard. `configurable: true` alone does not help; non-writability alone blocks shadowing.

**The lock was never a boundary.** Grant enforcement runs in the main process, keyed on
`event.senderFrame` and the grant ledger ([`../../src/broker/transport/ipc.ts`](../../src/broker/transport/ipc.ts),
[`net-capability.ts`](../../src/broker/net-capability.ts)); it cannot observe a renderer global.
`window.orivon` — hence the uncapped `orivon.net.connect` the routed `fetch` is itself built on
— reaches every ordinary tab regardless. And a same-origin subframe gets no preload, so an
unrouted `fetch` was always one line away.

**The lock arrived by copy-paste**, from `window.orivon`'s own deliberate lock, which does carry
a reason. That is the failure this ADR exists to stop repeating: the same paste is available to
the next global, and [`window.nostr`](../architecture/app-compatibility.md) is already planned,
a global whose entire promise is that *"every existing Nostr web client works unmodified"*.

## Alternatives considered

**Fix each global as an app reports it.** Rejected on the project's own success metric: the
genericity test in [`../mvp-scope.md`](../mvp-scope.md) claims app #3 costs dramatically less
than app #1, and a per-app rediscovery of the same one-line cause is that claim failing.

**One shared `defineAppGlobal()` helper every install site calls.** The obvious Rule 3 answer,
and impossible here: `installFetchRoute`, `installOrivon` and `installGlobals` are serialised
with `Function.prototype.toString()` and re-evaluated in the main world, so they may not
reference anything outside their own bodies. A helper is exactly what they cannot call. That
constraint is what makes a source-scanning guard the right tool rather than a lazy one.

**Unlock `window.orivon` too, for absolute fidelity.** Rejected. Nothing tries to shadow it, the
platform sets no contract for its shape, and locking it costs an app nothing — while it does buy
one property: a third-party script sharing the page cannot swap `orivon.net.connect` and have
every other script transparently use the substitute.

## Reasoning

The capability API is the durable asset, and an app is written against a *platform*, not only
against `orivon.*`. A global that does not behave like the thing it replaces is a divergence,
and ADR-0017 already establishes that a silent divergence in a web platform API is a trap. This
generalises that rule from one API to the surface as a whole.

The distinction that decides each case is whose contract the name belongs to. `fetch`, `process`,
`setImmediate` and `clearImmediate` are borrowed, and their descriptors are part of what an app
may rely on. `orivon` is Orivon's own, and Orivon sets its terms.

## Consequences

- **A hostile script sharing an app's realm can substitute a borrowed global** and observe what
  every other script sends through it. It can already call `orivon.net` directly, so it gains no
  reach it did not have — but it gains quiet, and that is stated rather than lost.
- **An app that replaces a routed global opts out of routing.** Its requests then take Chromium's
  own path, with CORS, which is what the app asked for by replacing the binding.
- **A future global must be written this way**, including `window.nostr`. The guard is what makes
  that survive being forgotten.
- **`process`, `setImmediate` and `clearImmediate` stay plain assignments.** That is already the
  platform's descriptor. [`../../src/shim/tests/globals.test.ts`](../../src/shim/tests/globals.test.ts)
  now asserts it, since nothing previously did.

## Reversibility

- **Cost to reverse:** moderate. Re-locking a global is one line, but apps written against the
  promise are not under this project's control, and breaking them is silent.
- **What would make us revisit:** a demonstrated attack that a locked borrowed global actually
  prevents and the broker does not — that is, one where the page's own realm is the boundary
  being defended. Absent that, a page-internal integrity property no browser offers is not worth
  the apps it costs.
