# ADR-0018: A tab is isolated because the user consented, not because the app is installed

- **Status:** accepted
- **Date:** 2026-09-16
- **Type:** architecture
- **Decided by:** owner

## Decision

An origin's tab runs in its own Electron session partition when **the origin holds at least one
live grant**, or when **the origin is currently served from the pinned cache**. Otherwise it
shares the shell's default session.

Installation is **not** a condition. In the owner's words:

> You still keep storage of an application if you granted permission to do so, it doesn't matter
> if you install it to run merely on local or not, that's a completely separate thing.

So [`src/main/tab-view.ts`](../../src/main/tab-view.ts)'s `partitionForTarget` reads
`Broker.app.hasGrantsSync` and the loader's serve registry. It deliberately does **not** read
`isRegisteredSync`, which answers a different question: "is a manifest loaded this session".

**This amends the 2026-09-15 rule, which said only an installed app is isolated.** That rule's
own reasoning, that an ordinary website has no grant and no app storage to protect, is kept intact
and is what this ADR preserves; only its *test* was wrong. It asked about installation when the
thing it meant was consent.

**The cache arm is not a second policy.** It is what makes the first one reachable. ADR-0007
intercepts a cached bundle inside the app's own partition, on purpose, so that the same URL in an
ordinary tab still reaches the real network. An origin served from cache whose tab sat on the
default session therefore could not load *at all*: nothing in that session answers its scheme.
The origin has to be in its partition before it can render the page that asks for consent.

## Context

[`open-questions.md`](../open-questions.md) A109 and A108. The 2026-09-15 change fixed a real and
severe problem: partitioning every origin meant every cross-origin navigation swapped the whole
`WebContentsView`, and a fresh view starts with empty `navigationHistory`. Measured at the time:
same-origin back worked, every cross-origin back was dead. One clicked link killed the back
button.

The fix gated isolation on `isRegisteredSync`. That gate was wrong in two directions at once:

1. **Too narrow.** A cached app registers its protocol handler through
   `registerAppOrigin`, which does not touch the broker's app registry. Both
   [`electron-serve.ts`](../../src/loader/electron-serve.ts) and
   [`delivery-provenance.ts`](../../src/main/delivery-provenance.ts) already say in comments that
   these are two separate registries. A pin served from cache but absent from the broker's
   registry got no partition, so its tab landed on the default session where its handler does not
   exist, and the page could not load. `test/e2e-serve-from-cache.test.ts` failed exactly there:
   *"fixture tab failed to navigate against the registered handler"*.
2. **Wrong axis.** Installation and consent are independent. An app can be loaded this session
   with nothing granted to it, and an origin can hold grants restored from disk before anything
   registers a manifest for it this run, and A158's hydration seam exists precisely to make that
   second case true.

## Consequences

- `Broker.app` gains `hasGrantsSync(origin)`, synchronous for the same reason `isRegisteredSync`
  is: a tab's partition is fixed when its `WebContentsView` is constructed, with no round trip to
  await. It reads the same in-memory ledger `grants()` does.
- `electron-serve.ts` gains `isOriginServedFromCacheSync`, backed by a module-level set that
  `registerAppOrigin` itself maintains. **The set exists so routing and interception cannot
  drift**: the one call that installs a handler is the one call that records it. That is the
  defect above, fixed structurally rather than by keeping two registries in sync by hand.
- **Do not replace that set with a probe of Electron's own registry.** Asking
  `session.fromPartition(...).protocol.isProtocolHandled(...)` *creates* the session it asks
  about, and `partitionFor` yields a `persist:` partition, so probing per navigation would mint
  an on-disk app partition for every ordinary website visited, reintroducing the cost A109
  removed. The async `isOriginServedFromCache` may still probe, because it runs only for an
  origin already on screen.
- **First visit is still unisolated, and that is correct.** Before any grant exists, a
  network-delivered origin is an ordinary website. It becomes isolated when consent is given,
  which swaps the view, and that is cheap at that point because there is nothing stored yet.
- `appTabArgsFor`'s `--orivon-app-tab` flag is untouched and still reads `isRegisteredSync`. It
  gates ADR-0017's `fetch()` routing, which is a question about a loaded app, not about storage.

## Alternatives rejected

- **Register the cache handler on the default session instead.** Directly forbidden by ADR-0007:
  *"the same URL opened in an ordinary browsing tab must reach the real network normally"*. A
  global interception would mean Orivon silently serving cached content for any site.
- **Collapse the two registries, so nothing may be served without being registered with the
  broker.** Conceptually cleaner, and worth revisiting once build step 4's install path is
  finished. Rejected now because that path is still being written, so the invariant could not yet
  be enforced.
- **Treat it as a test-only gap** and fix the dev hook. Rejected: it assumes production always
  installs before it serves, which is an assumption about code that does not fully exist yet.

## Verification

`test/e2e-serve-from-cache.test.ts` passes unchanged; it is the case this restores.
`e2e-session-partitions` and `e2e-redirect-partition` were rewritten to grant their fixture
origins, because two ungranted localhost fixtures now correctly share the default session and
there would otherwise be no partition to observe. Full e2e suite: 17 files, 42 tests, all
passing. Unit suite: 4698 passing.
