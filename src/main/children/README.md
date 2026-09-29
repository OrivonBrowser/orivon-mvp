# `src/main/children/`: the hidden host each app's children run in

**What lives here.** [ADR-0046](../../../docs/decisions/ADR-0046-an-app-s-children-live-until-its-last-page-closes.md)'s
Electron half. `page-tracker.ts`: a pure count of live pages per origin, with a one-shot
"this origin just went to zero" subscription, no `electron` import. `watch-pages.ts`: feeds
it from every real `WebContents` the process makes (`did-navigate`, `destroyed`,
`render-process-gone`). `child-host.ts`: one offscreen, never-attached `WebContentsView` per
app origin, in an in-memory session that answers the host's own document with the app's live
CSP and delegates every other request to the session the app's own tabs already load from.
`registry.ts`: the one entry point a tab's IPC request reaches -- derives the origin from
`event.senderFrame`, refuses a tab that is not a registered app, gets or creates that origin's
host, and hands a fresh `MessageChannelMain` across (one end to the host, the other back to
the tab). `children-subsystem.ts`: registers all of it and answers
`CHILD_HOST_CONNECT_CHANNEL`.

**What it depends on.** `electron`; [`../../broker/`](../../broker/) (`broker-contracts.ts`
types, `policy/origin.ts`, `grants/origin-hash.ts`, `transport/relay/port-transport.ts`'s
`ControlEvent`/`PortDeliveryFrame`); [`../../loader/electron/serve.ts`](../../loader/electron/serve.ts)
(`liveCspHeaderFor`); [`../../loader/serve/csp.ts`](../../loader/serve/csp.ts) (`ISOLATION_HEADERS`);
[`../shell/tab-view.ts`](../shell/tab-view.ts) (`partitionForTarget`); [`../shell/lock-navigation.ts`](../shell/lock-navigation.ts);
the top-level `channels.ts` and `registry.ts`. Only `watch-pages.ts` and `child-host.ts`
import `electron`; `page-tracker.ts` is unit-tested under plain vitest, and `registry.ts`'s
sender check is tested the same way with a synthetic `ControlEvent`.

**What it must never import.** [`../../renderer/`](../../renderer/) code (the repo-wide rule).
Nothing security-relevant about a host's session may live outside this directory and
`../sessions/`: the partition, the permission handler and the document response all live here,
the same reason `../sessions/README.md` gives for `web-context-host.ts`.

**Durable or tied to Electron.** `page-tracker.ts` is plain TypeScript and would survive an
engine change; every other file here is tied to Electron's `Session`, `WebContentsView` and
`WebFrameMain`. What a child actually runs as -- a Web Worker, the routing between a page and
its host -- lives in [`../../shim/worker/`](../../shim/worker/) and
[`../../shim/child-process/`](../../shim/child-process/), both durable.

**Owner stream.** `shim` (ADR-0046).

## Design notes

**Why the page tracker and the host pool are two files, not one.** `page-tracker.ts` answers
one question -- "does this origin have a page left?" -- from plain events, with no idea a host
exists at all; `child-host.ts` answers a different one -- "what does this origin's host look
like?" -- with no idea when to close one. `registry.ts` is the only place that connects them,
which is what let ADR-0046's own build step land each half with its own unit tests before the
wiring between them existed.

**The host's own document is served at a real `https://<origin>/.well-known/orivon/child-host`
path, never a `data:` document.** A `data:` document takes the origin as its base but carries
no headers of its own, so it can never be cross-origin isolated -- measured in
`docs/decisions/ADR-0046-an-app-s-children-live-until-its-last-page-closes.md`'s Context. The
host's own session answers that one path itself and delegates everything else (a child's
module imports, a spawned program's bytes, any network request the app's own grants admit) to
the session the app's own tabs already load from -- `../shell/tab-view.ts`'s
`partitionForTarget`, so a cached app and a network-served one are each served exactly as their
own tabs are.

**The host is never a counted window, and needs none.** An offscreen, never-attached
`WebContentsView` is not what Electron's own `window-all-closed` counts; a closer read found
that Orivon's shell already keeps the process alive with no counted window open
(`src/main/index.ts`'s own handler), so nothing here has to give the host a hidden
`BrowserWindow`/`BaseWindow` of its own just to survive the last visible tab closing under it.
See the ADR's Context for the measurement.

**`registry.ts`'s `watching` set only avoids redundant subscriptions, never a correctness fix.**
`page-tracker.ts`'s own count already waits for the LAST page regardless of how many listeners
are subscribed -- two tabs of one app both calling `connect()` before that origin's host exists
yet would otherwise each add their own `onceEmpty` listener, and both would fire (and both call
the already-idempotent `pool.close`) the moment the count actually reaches zero. `watching`
just keeps that down to one subscription per origin, and is cleared exactly when it fires or
the host is closed some other way, so a later child at the same origin, with a fresh host, is
watched again.
