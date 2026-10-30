# `src/main/route/`: the network route an installed app, a website or the whole browser can have

**What lives here.** The part of [ADR-0080](../../../docs/decisions/ADR-0080-an-installed-app-can-send-everything-through-one-proxy.md)
and [ADR-0082](../../../docs/decisions/ADR-0082-a-websites-tunnel-state-is-kept-per-origin-and-a-website-that-differs-from-the-default-has-storage-of-its-own.md)
and [ADR-0084](../../../docs/decisions/ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md)
that is tied to the running browser: which origins (apps and websites) the person routed and through which tunnel, whether the whole browser goes through the tunnel, and what routing does to Chromium.

| File | Job |
|---|---|
| `route-state.ts` | Pure: the tunnels (`nym`, `socks5`), the rule that an origin's entry (a tunnel or `off`) overrides the browser's default, and the entry that makes an origin go through a tunnel or off (the tunnel itself, even when it is the default's; for no tunnel, `off` while the whole browser is on one and none otherwise) |
| `route-store.ts` | What the person set per origin, in `routes.json` under the profile (memory only in a private session): each origin's entry (the tunnel it goes through, or `off`), and the websites that have storage in each of the three profiles; a file written before the profiles, or before each origin named its tunnel, is migrated once (`kinds-migration.ts`). Versioned, every entry checked at read, written atomically. A switch that cannot be saved throws and changes nothing. With `onlyKind` (a private window held to Nym) an `off` entry or the other tunnel is refused the same way. A file that is there but cannot be read is kept aside and reported as `unreadable`; the storage in Nym's profile that is really the proxy's is kept as foreign to Nym, so moving a website to Nym clears it first and tells the person |
| `route-hub.ts` | One route and one front per identity, over the store, the address of each tunnel and the browser-wide setting: each origin goes through the tunnel its entry names (the tunnel chosen in Settings when it has none), an app has its own, every website whose entry is a tunnel shares that tunnel's profile identity (`NYM_PROFILE_ORIGIN`, `PROXY_PROFILE_ORIGIN`), and every other origin that follows the default shares the shared one (`SHARED_ORIGIN`); the `routeFor` the broker and the loader read, the health, the tunnel and profile an origin has, which tunnels are in use, a refusing route for an origin routed through the proxy while no address is saved, and, while the list cannot be read, every origin through the default tunnel or through Nym when that has no address (`unreadableTunnel` names that tunnel) |
| `kinds-migration.ts` | The one-time move to a routes file that names each origin's tunnel: when the saved choice was the proxy, renames the tunnel profile's folder to the proxy profile's before any session opens it (never merging, never throwing) and marks the file; a rename that failed (a handle held on the folder) leaves the file unmarked for the next start, three starts at most, and after that (or for a folder that cannot be merged) the proxy-era storage left in Nym's profile is recorded as foreign to it |
| `dead-end.ts` | A listener on a random loopback port that accepts and closes: the place a session is pointed at to stop it, so a stopped request fails at once and no other program on this computer is shown a destination name |
| `front.ts` | The loopback HTTP proxy Chromium is pointed at: a `CONNECT` or an absolute-form request becomes a route connection, and only a caller that sends the secret made for it is answered; a plain http request the route cannot carry is answered with a short page that says so, not an empty one |
| `route-controller.ts` | Points each of an identity's sessions at its front, puts the WebRTC policy on every web contents in them, stops every session the runtime creates while the whole browser is on the tunnel and points it at the shared front unless its maker claims it (`own-proxy.ts`), points `app.setProxy` at the shared front, answers how a session leaves (the tunnel of the front it is pointed at, or held shut), stops an identity's sessions in the very turn it is switched on, closes what the app held open when the route changes (sessions first, then the broker's handles), reloads every page in them on a switch, and answers the front's proxy challenge. One app's switches run in order and never behind another app's |
| `route-service.ts` | The hub, the controller and the store together, with the proxy address, the choice of default tunnel and the browser-wide setting followed once the settings are read (`targetOf(kind)` is where a tunnel leaves, `proxy()` where the default one does, for Orivon's own requests and the local nodes); also `nodeEndpoint`, where a local node's traffic leaves while the whole browser is on the tunnel (the tunnel's SOCKS5 address with a sign-in of the node's own, starting Nym if need be), and `onNodeRouteMoved`, which fires when an address it handed out stops being Nym's |
| `route-subsystem.ts` | Starts them, wires Electron's sessions (every `session-created`), web contents, `login` event and `app.setProxy` in, makes the session that only follows the system, and publishes `ctx.routes` |
| `nym-subsystem.ts` | The Nym tunnel as the shell reaches it: starts the host on the first ask (a quiet loopback port and a secret made for each start), follows what it reports, stops it ten minutes after its last tunnel, refuses to start it with a system proxy configured or without its files, and runs the Settings Test, which answers within one minute of the press whatever it waits for (the host starting, a tunnel coming up), with the host's reason when a tunnel did not come up. Electron-free over a `ProcessSupervisor` |
| `nym-launch.ts` | The one file of Nym that imports `electron`: the utility process (forked through [`../diagnostics/host-fork.ts`](../diagnostics/host-fork.ts), so what it prints reaches the log), where the module's files are, the proxy check |
| `nym-supervisor.ts`, `nym-messages.ts` | Keeps the host's process running, and checks every message it posts |
| `nym-provider.ts` | The route provider of an app on Nym: the SOCKS5 provider at the host's current port, with the app's isolation user name and the host's secret, asking `nym-subsystem.ts` for the address at each use. A Nym that cannot run is an `unreachable` refusal, never a direct dial. It declares `dialBudgetMs` (110 s), the time the broker lets one connection of the app take where a direct dial gets 30 s: a tunnel coming up takes up to 95 s and a stream up to 45 s. `NYM_TARGET` is the route target that stands for it |
| `main-pace.ts` | The patience of the requests main itself makes (a Web3 Score lookup): the direct route, or the one meter of the tunnel, so what one lookup learned of how slow the tunnel is the next is patient for (`../../protocols/route-pace.ts`) |
| `nym-status.ts`, `nym-test-seam.ts` | What Nym is doing, as plain data; and, in a test build only, a stand-in module run in place of the pinned one |
| `isolation-secret.ts` | The secret the SOCKS5 user names are made under: the profile's own, kept with the one the verifier keeps for the IPFS node's store keys (`../verifier/verifier-store.ts`) so a new profile has its own and clearing browsing data replaces it; the names last for the run only if it cannot be kept |
| `forget-watch.ts` | Clears the route of an app the broker no longer knows, and lets go of its front and sessions |
| `route-domain.ts` | What the Settings page may ask: whether the proxy answers (never from a window held to Nym) |
| `lookup-session.ts` | The session the browser's own lookups about a routed app, a tunnelled website, or a site a temporary routed tab shows, go through (a tab icon from another host, the Web3 Score provider), the session a lookup about a website set to off uses while the whole browser is on the tunnel, and the answer to the front's proxy challenge for a request made from main |
| `routed-fetch.ts` | A GET made by main through that session, as a `Response`, by `net.request` so that it can answer the challenge itself (`../../loader/electron/request-fetch.ts`) |
| `own-requests.ts` | How Orivon's own requests (self-update, telemetry, the bug report, suggestions, a manifest read, the loader, a Web3 Score lookup about no origin) leave: unchanged with the browser-wide setting off (except that a request about a website with a tunnel of its own, an app manifest or the loader's reads, is made in that tunnel's profile session: `siteSession`), through the tunnel with it on, on the system's proxy for an origin set to off, and, for a website with a tunnel of its own, in that tunnel's profile session whatever the setting and the default tunnel are; they wait, a bounded time, for the sessions to follow a change of the setting, and are refused when they do not. It also carries the two calls the local nodes make (`ownNodeEndpoint`, `onOwnNodeRouteMoved`), since a node's traffic is Orivon's own |
| `onion-guard.ts` | Pure: whether a request for an onion address (`.onion`) is cancelled in a session, which it is unless the session goes through the person's own SOCKS5 tunnel, and the memory of the main-frame loads it cancelled that the sheet over the tab reads to say why |
| `own-proxy.ts` | The sessions that set a proxy of their own, which the shared identity leaves alone |
| `system-proxy.ts` | The question T20 asks: does the system's proxy apply?, answered by a session that only follows the system |
| `legacy-sites.ts` | Clears, once, the sessions websites had of their own before the profiles |
| `leave-decision.ts` | Pure: whether a page of a routed app opening an address needs the person asked first (not its own origin, not an installed app whose route is on; a page with no web address counts as the app whose session it runs in), and as what: a website, an installed app, or a page Orivon serves itself |
| `served-origin.ts` | Pure over the protocol registry: whether an address is one Orivon's own nodes fetch (a protocol's scheme, a host the verifier answers for), and how a person reads it |
| `temporary-routes.ts` | The in-memory session a website opened "through my tunnel" runs in: announced as a website session first (a tab is refused if any control cannot be installed on it), then pointed at a front and tunnel sign-in of its own, leaving by the tunnel of the page that opened it, released with its last tab |
| `route-switch.ts` | Sending an origin through a tunnel or through none (`choose`), taking a website's entry away so it follows the default (`forget`), why it cannot be (`blockedFor`), and whether a website is to be told first (`noticeFor`), shared by the app card, the site-info popover, the Settings list and the question below; also the list of origins with a setting or storage of their own, and clearing a website's storage |
| `site-partition.ts` | Pure: the profile an entry puts a website in (a tunnel entry is that tunnel's profile, `off` the direct one), the name of a profile's session (`persist:tunnel-profile` for Nym, `persist:proxy-profile` for the proxy, `persist:direct-profile`, or the same with `-memory` for an origin that may not be written to disk) and which origins can be switched |
| `site-routes.ts` | What the shell reads to put a tab in its profile's session, supplied once by `route-subsystem.ts`, the call that makes the session ready before a view is made in it, whether a session sends an address as its own session would (the same tunnel included), and the rule every session's main-frame guard applies, and, in a window held to Nym, the one tunnel a tab's choice may be (`heldTo`: a choice that is not Nym is ignored by the session and the guard) |
| `site-always.ts` | Pure: what "Always use for this site" does, as a table of the tab's choice, the website's entry and whether the browser is on a tunnel: when the switch is on or available, the steps that turn it on, off, or move a row (`planAlwaysOn`, `planAlwaysOff`, `planMove`), none of which changes the tunnel the page leaves by |
| `tab-tunnel.ts` | Pure: a tab's tunnel choice (Nym, the proxy or direct), the profile a website runs in under it (a tunnel choice wins over `off` and over the other tunnel; `direct` yields to a tunnel the website has), and the two answers the shell supplies once (which choice the tab showing a web contents carries, which tunnel a tab shows an origin through, none for an installed app, which keeps its own route), and the choice a window held to one tunnel allows (that tunnel's, or none), the tunnel a tab's choice sends an origin through (`tunnelForTab`), the tunnel the websites of a tab with no entry of their own take (`tabWebsitesTunnel`: the tab's tunnel, else the one every website takes while the list cannot be read, which a direct choice yields to, else the browser's), the tunnel a page really goes through (`tunnelOfPage`: the tab's choice over the website's entry, else the entry, else the browser's), and the choice a tunnel switch of the tab's list sets (`choiceForSwitch`: the tunnel, or `direct` when the whole browser is on the tunnel and nothing remains to fall back on, else none) |
| `site-sessions.ts` | Says which profile sessions this run has made, so a clear of site data reaches the memory ones without making any, and makes a profile's session ready: fits it with the controls every website session carries, points it at its front (or leaves the direct profile on the system's proxy), loads the person's extensions into it, and holds its requests until then |
| `tunnel-mark.ts` | Pure: what the address bar's tunnel button says about the page in front (`on`: purple, `down`: the warning colour) |
| `leaving-routes.ts` | What the shell asks of all this when a routed app's page opens an address: the decision, the temporary session and the app switch, both through the tunnel of the page that opens the address |

**What it depends on.** [`../../broker/route/`](../../broker/route/) (the route, its SOCKS5 provider and the probe), [`../verifier/process-supervisor.ts`](../verifier/process-supervisor.ts), [`../diagnostics/host-fork.ts`](../diagnostics/host-fork.ts) (how a host is forked), [`../verifier/verifier-store.ts`](../verifier/verifier-store.ts) (the profile's secret), [`../verifier/local-node-artifact.ts`](../verifier/local-node-artifact.ts) and [`../verifier/loopback-port.ts`](../verifier/loopback-port.ts) (the Nym host is supervised, checked and given a port as a local node is), [`../../protocols/nym-tunnel/protocol.ts`](../../protocols/nym-tunnel/protocol.ts) (what the host says),
[`../settings/proxy-checks.ts`](../settings/proxy-checks.ts), [`../../broker/grants/origin-hash.ts`](../../broker/grants/origin-hash.ts), [`../../broker/policy/origin.ts`](../../broker/policy/origin.ts), [`../../protocols/builtin.ts`](../../protocols/builtin.ts) (which addresses Orivon serves),
[`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts),
[`../../loader/electron/request-fetch.ts`](../../loader/electron/request-fetch.ts) (the `fetch` that signs in to a front itself), and `electron` for types, except
`route-subsystem.ts`, which also reaches [`../extensions/`](../extensions/) (the person's extensions in a profile) and [`../verifier/`](../verifier/) (the host restarts when the setting flips).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).
Nothing here dials a destination itself: a stream to a destination comes from the route's provider and from nowhere else.

**Tied to Electron?** Only `route-subsystem.ts` and `nym-launch.ts` import an `electron` value; the rest runs under plain vitest against fakes
and a SOCKS5 server on loopback ([`../../broker/route/tests/`](../../broker/route/tests/)).

**Owner stream.** `broker`.

**Every path to the network, and whether it takes this route:** [`docs/architecture/egress.md`](../../../docs/architecture/egress.md). A file added here or elsewhere that can reach the network is a row there (`npm run check:egress`).

## Design notes

**An onion address is carried by the person's own SOCKS5 tunnel and by nothing else.** A lookup of one tells a resolver which hidden service the person is about to visit, and Nym's tunnel looks names up at a public resolver that cannot answer for one. So `route-subsystem.ts` registers a handler on every session, with the guard for the main frame, that cancels a request for a `.onion` host of any scheme and resource type, WebSocket included, unless the session goes through the SOCKS5 tunnel (`onion-guard.ts`). It runs after the hold on a profile session that is not yet pointed, so a session coming up through the person's tunnel is not refused for being unpointed; a session that is stopped, on Nym or on the system's proxy is. `nym-provider.ts` refuses an onion name before it asks for the tunnel, and `own-requests.ts` refuses one unless the request leaves through that tunnel. A system-wide SOCKS5 proxy is not asked about: a session that follows the system refuses the name.

**Nym is a route target that names no address.** The host's port is new at each start, so the route to Nym is built
against `NYM_TARGET` (`nym.invalid`, port 0) and its provider asks `nym-subsystem.ts` for the real address at each connection.
Each origin's route is built against the target of the tunnel it picked, so one site can go through Nym while another goes through the address. A switch from one tunnel to the other gives the origin's front up, so the route table builds the provider again and the hub closes what the origin held. An address typed changes the routes of the origins on the address alone.
While Nym's host is coming up a connection waits for it (up to the SOCKS5 provider's 70 seconds); if it cannot run the
connection fails and the Settings row and the site-info popover say why.

**The front is HTTP because Chromium cannot sign in to a SOCKS proxy.** It can send a user name and password to an HTTP
proxy, so each app's front demands one secret, random per run and held only in this process, and the controller answers
the `407` it gets from the application's `login` event, for that front's port alone. That event is raised for web contents
only: a request the main process makes in an app's session (a tab icon, a Web3 Score lookup) is made with `net.request`
and answers the `407` in its own `login` listener, because `Session.fetch` has no way to. Without a secret any program on
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
on the system's proxy stays marked as pointed at the front, so the next pass tries again, forgetting its app included.

**A list of routed apps that cannot be read is not "nothing routed".** A missing file means none; a file that is there
and cannot be read or understood is copied to `routes.json.corrupt`, left where it is and never written over, and
counts every origin as routed, through the default tunnel (or through Nym when that has no address, and stopped when Nym is switched off or down), never direct. An app cannot be
switched off meanwhile, because which ones were routed is not known; the Settings card says so in one sentence. A
switch that cannot be saved is refused and changes nothing, so a switch never shows on when it is not kept.

**An app whose session could not be pointed at its front is stopped, not opened as a website.** The loader gives it a
partition answered by a handler that refuses everything and says the tunnel could not start
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

**A routed app's page opening an address outside its sessions asks first.** The shell stops the navigation or the window
(`../shell/leaving-route.ts`, `../shell/popups.ts`), asks in the tab's question panel, and acts on the answer; the
decision (`leave-decision.ts`) and the sessions it needs live here. *Through my tunnel* opens the website in a session from
`temporary-routes.ts`, pointed at its own front through the controller's `prepareTemporary` (the one place a session
is pointed at a front, so the app sessions' rules apply to it too); it is never registered with an app, so a change of
an app's route cannot repoint it. It is in memory because its name has no `persist:` prefix, and it is cleared when the
last web contents in it is destroyed. A page Orivon serves itself (an address the protocol registry serves, or a `.eth` name) is asked about with *Directly* and *Cancel* only: the verifier host and the Swarm node fetch it and are not routed per app. One question is open per app at a time, in any of its tabs; its other requests meanwhile are cancelled unasked and nothing is remembered. A popup that asked for a window of its own is adopted into the app's routed session
and is not asked about; an answer comes after `window.open` has returned, so such an open returns `null` whatever is
chosen. A tab moved into a temporary session records it (`routedAway`) so that Forward onto that page does not load it
in the shared session while the temporary one is alive.

**A website with an entry runs in a profile's session, held shut until it is pointed.** `partitionForTarget` asks `site-routes.ts` which profile the origin's entry names; a view made in that session calls `ensureSiteSession` first, which announces the session to `../sessions/website-sessions.ts` (so every control a website's requests meet in the shared session is installed on it too), waits for the controller to point it and loads the person's extensions into it. A `webRequest` handler holds every request until then, so a request made in the first moments waits for the front instead of going out on the system's proxy, and a session that could not be made ready refuses everything. The moving of open tabs is the shell's (`../shell/install-site-sessions.ts`): this directory never imports a tab. Where a website lives follows its own entry alone, so turning the browser-wide setting over moves none.

**A tab's tunnel choice is read, never stored, here.** The choice belongs to the tab ([`../shell/tab-tunnel-choice.ts`](../shell/tab-tunnel-choice.ts)); this directory only asks for it through `tab-tunnel.ts`'s source, which the shell supplies once as it does `site-routes.ts`'s, so it never imports a tab. Every question "which profile does this origin run in?" that depends on the tab takes the choice as an argument (`sitePartitionForTab`, `mustLeaveSession`), and the main-frame guard reads it from the web contents that loads. Requests Orivon makes for a tab with a choice are made in the tunnel's profile session or not made: the lookups take it ahead of the website's own entry, and the address bar's suggestions have no page to ask about, so `ownFetchForTab` is made in the profile of the choice.

**The whole browser on the tunnel is one more identity.** `SHARED_ORIGIN` has the one front every session no origin claims shares: the default session, the shell's own, a local file's. A session is stopped when it is made (`session-created`) and pointed at that front, unless an origin prepares it first or its maker marks it as setting a proxy of its own (`own-proxy.ts`). `app.setProxy` points the requests made with no session at it too; the verifier host fetches through it with `net.request` and restarts when the setting flips. Orivon's own requests go through it or not at all (`own-requests.ts`), and a lookup about a website set to off uses a session that only follows the system, the same one T20 asks.

**The bypass rules of a tunnelled session add the names the verifier answers for.** `host-resolver-rules` sends `.eth` and the shared address
suffix to the verifier on this machine, but a proxy would otherwise be asked for the name first. The verifier's own fetches (gateway blocks, the
name's Helios RPC and CCIP-Read calls) for a website in the tunnel profile go through that profile's front, with the whole browser on the tunnel or off it: main marks each of the profile session's requests to the verifier (`../verifier/partition.ts`'s `withRoute`) and hands the host the front in its start message (`../verifier/host-proxy.ts`), so the tunnel button shows such a site as `on` like any other.

**Giving up a website's entry keeps its data in the profile.** The row stays in Settings, with the button that clears that site's data from the profile and nobody else's, until the person removes it
or the site goes back to the default with nothing stored. Setting the entry again asks nothing, because the site already has data in that profile.

**Every session that registers through the shared request owner refuses a main-frame load that belongs in another session and that the shell did not move.** The shell moves a tab into the session an address belongs in before the address commits (a link, a redirect, the address bar), including a move to the shared session from a session that would send the address differently from it (a direct profile, an app set to off, with the address on the tunnel: `../shell/pre-partition.ts`), and a popup of such a session is opened as a window of its own, or moved when it navigates (`../shell/popups.ts`, `../shell/popup-opener.ts`). A load that skips the move (a script's `loadURL`, a step in a view's own history onto an older page) would reach the site from the wrong session, so `route-subsystem.ts` registers a main-frame handler on every session as it is made that cancels it (`site-routes.ts`'s `mustLeaveSession`): a website with a profile in the shared session, and a routed website in a session that is not tunnelled. The person reopens the address. A sleeping tab wakes through the move (`../memory-saver/sleep-tab.ts`). Frames of the site inside another page are not covered, by design: they ride the page's session.

**Switching the whole browser on stops before it points.** The identity's sessions and `app.setProxy` go to the dead end in the turn the setting flips, the verifier host and the local nodes stop, and only then is the front pointed at; Orivon's own requests wait for that. The route starts ahead of the extensions, and a settings file that cannot be used counts as the setting being on.

**Nym has a switch of its own, and off is a refusal.** `network.nym.enabled` reaches `NymSubsystem.setEnabled` through
`followSettings` (and `createNym` reads it before the settings store exists). Off stops the host and answers every `ensure` with
`NYM_SWITCHED_OFF`, so a route to Nym fails closed like any other unavailable Nym: an app, a website or the whole browser set to
use the tunnel is stopped, never sent direct. Switching it on clears that refusal at once. The subsystem also keeps the last
`instances` report (`tunnels()`: connecting and open) and names its process (`processInfo()`) for the Available networks popup.
