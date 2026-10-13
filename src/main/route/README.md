# `src/main/route/`: the network route an installed app can have

**What lives here.** The part of [ADR-0080](../../../docs/decisions/ADR-0080-an-installed-app-can-send-everything-through-one-proxy.md)
that is tied to the running browser: which apps the person routed, and what routing one does to Chromium.

| File | Job |
|---|---|
| `route-store.ts` | The routed apps, in `routes.json` under the profile (memory only in a private session): versioned, every entry checked at read, written atomically. A switch that cannot be saved throws and changes nothing. A file that is there but cannot be read is kept aside and reported as `unreadable` |
| `route-hub.ts` | One route and one front per routed app, over the store and the proxy setting: the `routeFor` the broker and the loader read, the app's health, and a refusing route for a routed app with no proxy |
| `front.ts` | The loopback HTTP proxy Chromium is pointed at: a `CONNECT` or an absolute-form request becomes a route connection, and only a caller that sends the secret made for it is answered |
| `route-controller.ts` | Points each of an app's sessions at its front, puts the WebRTC policy on every web contents in them, closes what the app held open when the route changes (sessions first, then the broker's handles), reloads every page in them on a switch, and answers the front's proxy challenge. One app's switches run in order and never behind another app's |
| `route-service.ts` | The hub, the controller and the store together, with the proxy setting followed once the settings are read |
| `route-subsystem.ts` | Starts them, wires Electron's sessions, web contents and `login` event in, and publishes `ctx.routes` |
| `forget-watch.ts` | Clears the route of an app the broker no longer knows, and lets go of its front and sessions |
| `route-domain.ts` | What the Settings page may ask: whether the proxy answers |
| `lookup-session.ts` | The session the browser's own lookups about a routed app go through (a tab icon from another host, the Web3 Score provider) |

**What it depends on.** [`../../broker/route/`](../../broker/route/) (the route, its SOCKS5 provider and the probe),
[`../settings/proxy-checks.ts`](../settings/proxy-checks.ts), [`../../broker/grants/origin-hash.ts`](../../broker/grants/origin-hash.ts),
[`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts), and `electron` for types, except
`route-subsystem.ts`.

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).
Nothing here dials a destination itself: a stream to a destination comes from the route's provider and from nowhere else.

**Tied to Electron?** Only `route-subsystem.ts` imports an `electron` value; the rest runs under plain vitest against fakes
and a SOCKS5 server on loopback ([`../../broker/route/tests/`](../../broker/route/tests/)).

**Owner stream.** `broker`.

## Design notes

**The front is HTTP because Chromium cannot sign in to a SOCKS proxy.** It can send a user name and password to an HTTP
proxy, so each app's front demands one secret, random per run and held only in this process, and the controller answers
the `407` it gets from the application's `login` event, for that front's port alone. Without a secret any program on
this computer could use the route. The listener for that event is added ahead of the sheet that asks the person about
a proxy's challenge, which then leaves an already answered one alone.

**An app's sessions never get `direct`.** The proxy rule is the front alone, so a front that is down fails every request
with `ERR_PROXY_CONNECTION_FAILED` instead of falling back. Chromium bypasses loopback and link-local addresses
(169.254.0.0/16, fe80::/10) on its own accord, which would let a page reach the local network without the proxy, so
the bypass rules are `<-loopback>;localhost;*.localhost;127.0.0.1/8;[::1]`: that cancels the implicit ones and puts back
this machine alone, which the app's own loopback pages need. A session held on the rule that reaches nothing bypasses
nothing.

**A switch points the sessions and closes their connections before it asks the broker to close its handles.** A call
that never returns is cut off after ten seconds, and each app has a queue of its own, so one app whose handles do not
close holds neither its sessions open on the old route nor another app's switch. A session that could not be put back
on the system's proxy stays marked as pointed at the front, so the next pass tries again.

**A list of routed apps that cannot be read is not "nothing routed".** A missing file means none; a file that is there
and cannot be read or understood is copied to `routes.json.corrupt`, left where it is and never written over, and
counts every app as routed while a proxy is set (through the proxy, or stopped when it is down). An app cannot be
switched off meanwhile, because which ones were routed is not known; the Settings card says so in one sentence. A
switch that cannot be saved is refused and changes nothing, so a switch never shows on when it is not kept.

**An app whose session could not be pointed at its front is stopped, not opened as a website.** The loader gives it a
partition answered by a handler that refuses everything and says the proxy route could not start
([`../../loader/electron/app-partitions.ts`](../../loader/electron/app-partitions.ts)'s `prepareAppSessionOrStop`), and
the session is held on the rule that reaches nothing.

**The lookups made about a routed app read its route again for every hop.** A tab icon followed through redirects asks
for the route's session before each request, so a switch made during the chain applies to the next hop.

**A session is pointed at its front before the app is served from it.** The loader waits for
`beforeAppSessionServes` preparers before it registers an app's handler, so no page loads in a session that is not yet
confined; the child host awaits the same call before it loads its document. A web context keeps its discard-port proxy
instead: it answers `https` itself, refuses `http` and blocks WebSocket, so nothing of its own reaches a proxy.

**A routed app with no proxy is refused, not routed direct.** The hub gives it a route whose connect fails, and a front
that answers `503`. Clearing the proxy therefore stops the app instead of exposing it.

**Updates and name resolution are paused, not routed.** `Loader.load` answers `'up-to-date'` for an installed routed
app, and the Web3 Score lookup for a routed caller skips the two reads that cannot go through a session (the
verifier resolving a name, a gateway read of a manifest). Both are *provisional* until the verifier host takes a route
per request.
