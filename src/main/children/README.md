# `src/main/children/`: the hidden host each app's children run in

**What lives here.** [ADR-0046](../../../docs/decisions/ADR-0046-an-app-s-children-live-until-its-last-page-closes.md)'s
Electron half. `page-tracker.ts`: a pure count of live pages per origin, with a one-shot
"this origin just went to zero" subscription, no `electron` import. `watch-pages.ts`: feeds
it from every real `WebContents` the process makes (`did-navigate`, `destroyed`,
`render-process-gone`). `child-host.ts`: one offscreen, never-attached `WebContentsView` per
app origin, in an in-memory session that answers the host's own document with the app's live
CSP and delegates every other request to the session the app's own tabs already load from;
rebuilds it, rather than reusing it, once the origin's live grants have moved on from what it
was built with, and clears the session's own storage once closed.
`registry.ts`: the one entry point a tab's IPC request reaches -- derives the origin from
`event.senderFrame`, refuses a tab that is not a registered app (closing any host it still has,
rather than leaving one an unregistered origin can no longer reach), caps one connect in flight
per document, gets or creates that origin's host, and hands a fresh `MessageChannelMain` across
(one end to the host, the other back to the tab). `children-subsystem.ts`: registers all of
it, answers `CHILD_HOST_CONNECT_CHANNEL`, and logs rather than crashes the process should that
answer ever reject.

The page's own side of the handshake is `../../preload/expose-child-host-connect.ts` and
`../../shim/child-process/host-client.ts`: the isolated-world preload holds the connection
itself, and hands the page's own main-world code a small set of plain closures
(`start`/`send`/`kill`) instead -- never the raw port
([security-model.md](../../../docs/architecture/security-model.md)'s T17 row).

**What it depends on.** `electron`; [`../../broker/`](../../broker/) (`broker-contracts.ts`
types, `policy/origin.ts`, `grants/origin-hash.ts`, `transport/relay/port-transport.ts`'s
`ControlEvent`/`PortDeliveryFrame`); [`../../loader/electron/serve.ts`](../../loader/electron/serve.ts)
(`liveCspHeaderFor`); [`../../loader/serve/csp.ts`](../../loader/serve/csp.ts) (`ISOLATION_HEADERS`);
[`../shell/tab-view.ts`](../shell/tab-view.ts) (`partitionForTarget`); [`../shell/lock-navigation.ts`](../shell/lock-navigation.ts);
the top-level `channels.ts` and `registry.ts`. `watch-pages.ts` and `child-host.ts` import
`electron` at module scope; `registry.ts` imports `MessageChannelMain` from it as a value too
(everything else it needs is a type). `page-tracker.ts` is unit-tested under plain vitest, and
`registry.ts`'s sender check is tested the same way with a synthetic `ControlEvent`.

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

**The host is never a counted window, so it never keeps the process alive on its own.** An
offscreen, never-attached `WebContentsView` is not what Electron's own `window-all-closed`
counts. The last VISIBLE window closing ends the process (and every host with it) exactly as it
did before hosts existed; where the process stays running with no visible window (macOS,
outside a private session -- `src/main/index.ts`'s own handler), a host still closes with its
app's last page, the same as everywhere else. See the ADR's Context for the measurement this
rests on.

**`registry.ts`'s `watching` set only avoids redundant subscriptions, never a correctness fix.**
`page-tracker.ts`'s own count already waits for the LAST page regardless of how many listeners
are subscribed -- two tabs of one app both calling `connect()` before that origin's host exists
yet would otherwise each add their own `onceEmpty` listener, and both would fire (and both call
the already-idempotent `pool.close`) the moment the count actually reaches zero. `watching`
just keeps that down to one subscription per origin, and is cleared exactly when it fires or
the host is closed some other way, so a later child at the same origin, with a fresh host, is
watched again.

**Any new document in an app's only page ends its children, not only a reload.** A same-origin
link followed or a form posted counts exactly the same as reloading (`watch-pages.ts`'s own
`commit()`, run from `did-navigate`): it closes the previous document's page count before
opening the new one's, so the only page briefly reads zero regardless of what its next document
turns out to be. A crashed page (`render-process-gone`) closes it the same way.

**A host is rebuilt, never merely reused, once the origin's live grants have moved past what it
was built with.** The one document a host ever loads carries the CSP (and the session) that were
current at build time, and neither refreshes on its own afterwards -- a grant, a revoke, or the
app losing its registration entirely all count. `child-host.ts`'s `getOrCreate` compares a
signature of `broker.app.grants(origin)` against the one taken when the current host was built,
and `registry.ts`'s own `connect` closes an unregistered origin's host outright rather than
building it a fresh one it would never get to use. Checked on the next child a page starts, not
the instant the change happens: an already-running child of a host that goes stale this way
keeps its old session and CSP until that host is rebuilt or the app's last page closes, whichever
comes first.

**The host session is not proxied through a discard port.** Earlier, every dial the host
session's own network stack made outside `protocol.handle` -- as an isolated web context's
session is, to close off WebRTC's own ICE/STUN/TURN escape -- was sent to `http://127.0.0.1:9`
instead. Nothing here ever runs page code that could open an `RTCPeerConnection`, so the one
thing that proxy still reached was a child's own WebSocket, which it simply broke: `ws:`/`wss:`
never reach `protocol.handle` at all. A child's WebSocket now uses the host session's own network
stack directly, gated only by whatever the session's CSP and grants already allow -- and, unlike
`fetch`, never seen by a page's own service worker either way, since the delegation underneath is
a main-process `session.fetch`/dial, not a request any page's own registration can intercept.
`setWebRTCIPHandlingPolicy` stays, bounding what the session's own ICE gathering could still leak
even with nothing here ever opening a peer connection.

**A host's own preload reports itself ready before any page gets a port to it.** `child-host.ts`'s
`build()` waits (bounded) for `CHILD_HOST_READY_CHANNEL`, sent once `../../preload/child-host.ts`
has installed `orivon` and wired `ChildHost.addPage` with nothing throwing. Without this, a
preload that failed partway through (the sandboxed-bundling faults `../../preload/README.md`
measures) left a host indistinguishable from a working one from the outside: every page it was
ever handed a port to simply hung, forever, with no error anywhere.

**Closing a host clears its session's storage.** A child's IndexedDB or Cache Storage is the
host session's, not the app's own pages' (the ADR's own Consequences) -- and the partition name
is stable per origin, so without this the NEXT host built for that origin would inherit whatever
the previous one's children left behind. Nothing here promises a child's web storage survives a
host generation, so clearing it is the safer default.
