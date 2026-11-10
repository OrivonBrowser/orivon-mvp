# Egress: every file that can reach the network, and how it takes the tunnel

**What this page is.** The table of every file in `src/` that opens a socket, resolves a name, makes an HTTP
request or points a session at a proxy, with what it reaches, what it is for, and how it takes the tunnel (the
per-app route of [`ADR-0080`](../decisions/ADR-0080-an-installed-app-can-send-everything-through-one-proxy.md),
threat [T84](security-model.md)). `npm run check:egress` fails CI when a file the scan finds is not a row here, and
when a row names a file that is gone, so a path around the tunnel cannot be added without this page saying so.
The browser-wide setting `network.tunnel.everywhere` ([`ADR-0084`](../decisions/ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md))
takes every path marked *tunnelled while the whole browser is on it* through the tunnel, or stops it.

**What the scan finds.** A file that imports `net`, `tls`, `http`, `https`, `http2`, `dgram` or `dns` (with or
without `node:`; a type-only import does not count), the `socks` package or the broker's socket adapters
(`src/broker/adapters/`), calls Electron's `net.request` or `net.fetch`, a session's `fetch`, any `setProxy`, or
`globalThis.fetch`; calls the global `fetch` without declaring one of its own, or falls back to it; or constructs a
`WebSocket`, `EventSource` or `XMLHttpRequest`. Code that runs in a page or a worker (`src/renderer/`,
`src/preload/`, `src/shim/`) is not scanned for `fetch`, since its `fetch` is the page's own and rides the page's
session. A row may not name a file that is gone or that the scan no longer matches.

**The last column** says one of these:

- **Loopback.** Never leaves this computer.
- **Routed.** Takes the route of the app or website it works for, with the name unresolved here, and is refused or stopped
  when the route is down.
- **The tunnel's own way in.** Connects to the tunnel's SOCKS5 address, the person's own or the Nym host's loopback
  port, the one place a connection from the browser is direct by definition.
- **The tunnel's own way out.** Nym's own connections to its directory and gateways, made by the Nym host. They are
  direct by definition, since they are the tunnel; they show this computer's address to Nym's gateways, and a system
  proxy stops the host from starting, so they never go around one. That check asks the system's proxy, never the tunnel's front on the default session, so they stay direct (and Nym can start) while the whole browser is on the tunnel.
- **Tunnelled while the whole browser is on it.** With `network.tunnel.everywhere` on, the request goes through the
  tunnel (a request made with `net.request` that signs in to the shared front itself, or a session pointed at the
  front) or does not happen; an origin the person set to off is asked for on the system's proxy instead. With the
  setting off it is *not routed*.
- **Not routed.** Goes direct, or through whatever proxy the system gives the default session. An unrouted app
  or a website keeps this too.

A routed origin is an installed app or a website whose entry is a tunnel (Nym, or the person's proxy; a website lives in
that tunnel's profile), or, while the whole browser is on a tunnel, any app or website with no entry of its own, which goes
through the tunnel chosen in Settings ([`ADR-0089`](../decisions/ADR-0089-each-website-and-app-picks-its-own-tunnel-and-an-installed-apps-tunnel-is-set-as-a-websites-is.md),
[`ADR-0082`](../decisions/ADR-0082-a-websites-tunnel-state-is-kept-per-origin-and-a-website-that-differs-from-the-default-has-storage-of-its-own.md),
[`ADR-0084`](../decisions/ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md));
every other app and website is *not routed*, except in a tab that carries a tunnel choice: every website opened in that tab,
and in tabs opened from it, runs in that tunnel's profile until the tab closes, and the requests Orivon makes for the tab
(the lookups about the page, the address bar's suggestions) leave by the same tunnel or are not made
([`ADR-0101`](../decisions/ADR-0101-a-tab-can-carry-a-tunnel-choice-that-holds-for-every-website-it-opens.md)).

## The broker's sockets (durable)

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/broker/adapters/node-adapters.ts` | Any TCP host:port the broker's checks allow; the system resolver (`resolveHost` and `resolveLookup`, used by the local nodes and the broker's own tests) | An unrouted app's `orivon.net.connect` and `listen`; the local nodes | Not routed. A routed app never gets here: the broker uses the route's provider for it |
| `src/main/privacy/chromium-resolver.ts` | Chromium's resolver (`net.resolveHost`), with the Secure DNS setting applied | The names an unrouted app's `orivon.net.connect`, `connectSecure`, `udp` and `lookup` resolve before the broker's checks and the dial | Not routed. A routed app resolves nothing here: the name goes to its route An onion name is refused before Chromium is asked (`ONION_NEEDS_TOR`), so no resolver hears of it. |
| `src/broker/adapters/tls-adapter.ts` | The same hosts, over TLS | An unrouted app's `orivon.net.connectSecure` | Not routed. A routed app reuses its handshake over the route's stream (`routed-secure.ts`) |
| `src/broker/adapters/udp-adapter.ts` | Any UDP host:port the checks allow | An unrouted app's `orivon.net.udp`; the local nodes' DNS datagrams | Not routed. A routed app's socket is loopback-only and its other datagrams go through the route |
| `src/broker/capabilities/net-udp-route.ts` | Nothing: uses only `isIP` | A routed app's UDP socket decides which datagrams go through the route | Loopback |
| `src/broker/route/deadline.ts` | Nothing: uses only a timeout constant | One deadline over opening a routed connection | Loopback |
| `src/broker/route/routed-socket.ts` | The destination the app named, through its route | A routed app's `orivon.net.connect` | Routed |
| `src/broker/route/routed-secure.ts` | The destination the app named, through its route, over TLS | A routed app's `orivon.net.connectSecure` | Routed |
| `src/broker/route/socks5.ts` | The tunnel's SOCKS5 address: the person's, or the Nym host's loopback port (TCP, and the UDP relay it names; the datagram socket is bound first and its port declared in the request) | The route provider every routed path uses | The tunnel's own way in |
| `src/broker/route/socks5-probe.ts` | The person's SOCKS5 address | The Settings page's Test of an address: the greeting only, no stream. The Test of Nym opens one stream to a name through Nym's host instead (`src/main/route/nym-subsystem.ts`, through `socks5.ts`) | The tunnel's own way in |
| `src/broker/transport/ipc.ts` | Through the adapters above | Gives the broker its dial, TLS, UDP, listen and resolve functions, and the question "does a proxy apply?" (T20), asked of a session that only follows the system, never of the default session | Not routed for an unrouted app, which is refused unless the system has no proxy for the destination; a routed app is not asked. An app set to off while the whole browser is on the tunnel is such an app: its answer is the system's |

## The loader: apps, their files and the third parties they load

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/loader/electron/fetch.ts` | The address of an app: its manifest, bundle and update, over `https`; `.eth` and IPFS addresses through the verifier's loopback server | Installing, loading and checking an app | Tunnelled while the whole browser is on it: `net.request` in the default session, which is then the tunnel's, signing in to its front, with no name resolved here, after the sessions follow the setting (bounded wait, then refused); an app set to off goes on the system's proxy. A website with a tunnel of its own is fetched in that tunnel's profile session whatever the browser-wide setting and its tunnel are (its app manifest, its files), with its name resolved at the far end and never here. Not routed otherwise, and a routed app's update check is paused instead. A name the verifier serves is read through the session it would use and refused when that session has a proxy for it ([below](#names-the-verifier-serves-behind-a-proxy-the-system-sets)) |
| `src/loader/electron/request-fetch.ts` | Whatever the caller asks for, with `net.request`, through the session it is handed, or the process's own network context in a utility process | One `fetch` that signs in to the tunnel's front itself, because `net.fetch` and `Session.fetch` raise no `login` event for a request without web contents | The way Orivon's own requests, the verifier host and the Reader view's pictures take the tunnel: the Reader fetches in the source tab's session, so a picture is routed in a temporary routed tab, a tunnel-profile tab and the default session while the whole browser is on the tunnel, and not routed otherwise; it reaches only where its caller points it |
| `src/loader/reach/reach.ts` | The `https` hosts an app is granted (images, fonts, media, workers, `fetch`), by Node `https` with no session | The third-party requests an app's pages make; a web context's `https` | Routed: for a routed app the connection is TLS over the route's stream with no local name lookup. Not routed otherwise, after the T12 address check |

## The main process

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/main/browsing/favicon-fetch.ts` | The site a tab shows, and the host that holds its icon | A tab's icon, fetched by main | Routed for a routed app, a website with its tunnel on (its profile's or the default session's), a temporary routed tab (the lookup session), or a page a tab with a tunnel choice shows or is loading (that tunnel's profile session, ahead of the website's own entry). A website set to off while the whole browser is on the tunnel is looked up about on the system's proxy; not routed otherwise. An icon at an onion address is fetched only for a routed page, whose route sends the name on unresolved or refuses it; for any other page it is not fetched and its name is not looked up. While the name relay runs, a page with no route and no tunnel has its icon read through a pinned endpoint (`name-relay/pinned-endpoint.ts`): the relay looks the host up, the address is checked, and the read goes to that address only, again for each redirect's host; the relay does not run in this build. A page whose host the verifier serves is not fetched when the session would send that host to a proxy ([below](#names-the-verifier-serves-behind-a-proxy-the-system-sets)). |
| `src/main/browsing/score-provider-client.ts` | The Web3 Score provider the person chose | The page's judged level, by hash bucket | Routed for a routed app's, a tunnelled website's or a tunnel-choice tab's page (`fetchThroughRoute`; with the whole browser on the tunnel the Web3 reads that cannot go through a session ride the verifier host's tunnelled fetch). A website set to off while the whole browser is on the tunnel is asked about on the system's proxy; a lookup about no origin (an install, an update check) follows the default, through the tunnel while the whole browser is on it (`ownFetch`). Not routed otherwise. A provider at a host the verifier serves is refused when the session would send it to a proxy ([below](#names-the-verifier-serves-behind-a-proxy-the-system-sets)) |
| `src/main/children/child-host.ts` | The app's own session: the pin, and `reach` for a third-party `https` | Serving an app's child host document and files | Takes the app's route, since its session is pointed at the app's front |
| `src/main/consent/grant-prompt-origin.ts` | Nothing: uses only `isIP` | Writing an origin for the permission dialog | Loopback |
| `src/main/dev/local-ddoc.ts` | A loopback address or a developer `.eth` name, in developer mode only | Reading the DDOC file a local origin serves | Loopback |
| `src/main/diagnostics/report-runner.ts` | The usage-statistics server, when the person sends a bug report | Sending the report the person wrote | Tunnelled while the whole browser is on it (`ownFetch`): the report is sent through the tunnel or not at all. Not routed otherwise |
| `src/main/install/app-install-subsystem.ts` | The `https` origin of an app | Reading an app's manifest to ask for its grants without installing it | A website with a tunnel of its own is read in that tunnel's profile session (`ownFetch`) whatever the browser-wide setting says; otherwise tunnelled while the whole browser is on it, or on the system's proxy for an app set to off. Not routed otherwise |
| `src/main/local-files/local-partition.ts` | Nothing: reads a `file:` address | Serving a local file in a tab | Loopback |
| `src/main/omnibox/suggest-net.ts` | The person's search engine's suggestion address | Suggestions while typing in the address bar | Tunnelled while the whole browser is on it (`ownFetch`), and for a window whose active tab carries a tunnel choice, through that tunnel's profile session (`ownFetchForTab`): suggestions come through the tunnel or not at all. Not routed otherwise |
| `src/main/pages/serve.ts` | The renderer's dev server on loopback, in a source run only | Answering an `orivon://` page in development | Loopback |
| `src/main/route/front.ts` | Listens on `127.0.0.1`; opens streams only through the route's provider | The loopback HTTP proxy Chromium is pointed at for a routed app or website | Routed (this is the tunnel's local end) |
| `src/main/route/dead-end.ts` | Listens on a random `127.0.0.1` port, accepts and closes; reads and sends nothing | The place a session is pointed at to stop it (a session made while the whole browser is on the tunnel, one that could not be pointed, the requests made with no session), so a stopped request fails at once and no other listener on this computer is shown a destination name | Loopback |
| `src/main/route/name-relay/addresses.ts` | Nothing: uses only `isIP` and `BlockList`, to tell an address from a name and an address on a proxy's own machine from one outside it | Choosing which addresses the name relay asks a proxy to connect to | Loopback |
| `src/main/route/name-relay/pinned-endpoint.ts` | Listens on `127.0.0.1` behind a secret of its own; connects only to an address a caller pinned for a host and port, through the proxy the system names for the URL (by address, as `relay-opener.ts` does) or straight to it where the system sends the connection outside any proxy; looks no name up and refuses a host and port nobody pinned | The reads of a caller in main that checks an address first (a tab's icon, a CCIP-Read gateway's check), so the address it cleared is the address connected to | Not routed: the system's proxy, by address, or the address itself. Its challenge is answered by the route controller, so the broker refuses an app's socket to its port (T12). Nothing pins an address while the name relay is inactive, and it is inactive in this build |
| `src/main/route/name-relay/pinned-session.ts` | Nothing of its own: sets one in-memory session's proxy to a pinned endpoint's loopback port | The session a caller in main reads through a pinned endpoint | Loopback: `setProxy` to the endpoint's port only, with no bypass but the names the verifier serves, which a read here never names |
| `src/main/route/name-relay/proxied-lookup.ts` | The DNS-over-HTTPS server of the provider the Secure DNS setting names (Quad9 when it names none, or is `off` or `automatic`), through the one proxy the system names for a connection; the request carries the site's name, as a DNS query with no client subnet and no cookie. This computer's own resolver rules and hosts file are read without a packet (`resolveHost` with `localOnly`) | The address of a site's name, for the name relay | Through that proxy and nowhere else: each query is sent from an in-memory session set to that one proxy with no bypass rule and no direct fallback, and a lookup that cannot be made that way is refused, never answered by Chromium's resolver, this computer's DNS, the proxy by name or a second provider. No session is pointed at the relay yet, so nothing calls it |
| `src/main/route/name-relay/proxy-answer.ts` | Nothing: uses only `isIP` | Reading the system's answer to which proxy applies to a URL | Loopback |
| `src/main/route/name-relay/relay-lookup.ts` | Nothing of its own: uses only `isIP`; the lookups and the system's answer are handed in | The addresses of a site's name for a caller that checks them before it reads, through the proxy the system names for the URL (`proxied-lookup.ts`) or this computer's resolver where the system names none | Through that proxy and nowhere else; a first `DIRECT` answer is looked up on this computer, never a `DIRECT` after a proxy |
| `src/main/route/name-relay/relay-opener.ts` | Nothing of its own: uses only `isIP`; the connection is `upstream.ts`'s and the lookups are handed in | Opening the upstream for a connection the name relay's listener is asked for | Not routed: the system's proxy, by address (`upstream.ts`) |
| `src/main/route/name-relay/upstream.ts` | The proxy the system names for a URL (HTTP, HTTPS, SOCKS5 or SOCKS4; its own host name is looked up on this computer) and, through it, one address; for a first `DIRECT` answer, the address itself | Carrying one connection of the name relay by address, so that the proxy is asked for no name; nothing starts the relay in this build | Not routed: the system's proxy, by address, or the address itself where the system sends the connection outside any proxy |
| `src/main/route/proxy-mirror/pac-fetch.ts` | The address of the proxy script the system names (in its settings, or the environment's `auto_proxy`), and only that (`http:` or `https:`, redirects to the same kinds followed), through a session of its own set to `{ mode: 'direct' }`, with no cookies or credentials and nothing cached, at most a megabyte and thirty seconds | Copying the system's proxy script into the sessions that follow the system | Not routed, by design: the script is fetched as the system's own settings would have Chromium fetch it, direct, and the session sets a proxy of its own, so no tunnel, front or system proxy takes the request. It happens only while the settings or the environment name a script; the address and the text reach neither the log nor `orivon://report` |
| `src/main/route/proxy-mirror/read-kde.ts` | Nothing: uses only `isIPv4` and `isIPv6` | Telling an address from a hostname in KDE's proxy exceptions | Loopback |
| `src/main/route/route-controller.ts` | Sets the proxy of an app's or a website's sessions, and of every other session the runtime creates while the whole browser is on the tunnel: the front, or the dead end (the moment a session is made or switched on, before the front is had); also `app.setProxy` for the requests made with no session | Where a session takes the tunnel; it marks a session as changing from before each `setProxy` until the call ends (`proxy-answers.ts`) | Routed (it makes sessions take it) |
| `src/main/route/route-subsystem.ts` | Nothing of its own: wires the sessions, `app.setProxy`, the system-proxy session that T20 asks, the system-mirror session that Orivon's direct requests and the lookups about a site set to off use, and the system-check session where a copy of the system's proxy settings is tried (`proxy-mirror/`; it runs `gsettings`, and sets a proxy on the sessions that follow the system only after the check); registers the guard that keeps a name the verifier serves from a proxy the system sets, on every website session | Starting the routes | Routed (it makes the rest take the tunnel) |
| `src/main/self-update/update-check-runner.ts` | GitHub's releases API | Looking for a newer release | Tunnelled while the whole browser is on it (`ownFetch`): the check goes through the tunnel or does not happen. Not routed otherwise |
| `src/main/sessions/web-context-host.ts` | Nothing from the session: its proxy is a port nothing listens on | A web context answers `https` itself (through `reach`), refuses `http` and WebSocket | Takes the app's route through `reach`; the session's proxy only confines it |
| `src/main/settings/proxy-checks.ts` | Nothing: uses only `isIPv6` | Reading a SOCKS5 address | Loopback |
| `src/main/verifier/checkpoint-fetch-net.ts` | The two beacon servers of `DEFAULT_ENDPOINTS.checkpointBeaconApis` (`ethereum-beacon-api.publicnode.com`, `lodestar-mainnet.chainsafe.io`), and the beacon server the light client bootstraps from: Orivon's, or the one the person set in Settings > Web3 (a request to it asks for the bootstrap of a checkpoint to be used, never for the finalized head) | Asking for a fresh finalized checkpoint when the release's and the stored one are both past the age limit, as the verifier host starts, or when the beacon server has no bootstrap for the one in use | Tunnelled while the whole browser is on it (`ownFetch`): the request goes through the tunnel or does not happen. Not routed otherwise. **The exception** is the person's beacon server when it is `localhost` or a loopback or private address literal: the request is `local-rpc-fetch.ts`'s, Node sockets that read no proxy setting and never the tunnel's front (T12). An error names the server masked |
| `src/main/verifier/loopback-port.ts` | A free port on loopback | Choosing the port the verifier's server listens on | Loopback |

## Protocols

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/protocols/local-node/node-net.ts` | Public peers by TCP (among them the IPFS node's resolver, which asks `1.1.1.1:53` and `1.0.0.1:53` for peers' names in plain text, whatever the Secure DNS setting, and a circuit relay that a provider's record names, which the node dials to reach a provider that has no direct address; the relay sees this computer's address and the provider's, never the content), DNS resolvers by UDP port 53 (the Swarm node's), through the broker's adapters (a direct node) or through the tunnel (`node-route.ts`); listens on loopback | The local IPFS and Swarm nodes' sockets | Direct unless the whole browser is on the tunnel **and** "Use tunnel to run network nodes" is on, and a direct node does not run while a proxy the system itself sets applies (T20; beside the whole-browser tunnel the question goes to the session that follows the system, not to the tunnel's front). **Routed** when both are on: the process is started with `routed`, its dials, datagrams and name lookups all go through `node-route.ts`, and a node with no route has no network. What a direct node reveals while the tunnel is on is T86 |
| `src/protocols/local-node/service.ts` | The node's DNS-over-HTTPS endpoints with the process's own `fetch` (a direct node) or through the tunnel (a routed one); the node's own API on loopback; the adapters above | Running a local node, naming its peers, and waiting for its readiness | As `node-net.ts`: direct, or routed when the whole browser and the setting are both on; loopback for the readiness check |
| `src/protocols/local-node/node-route.ts` | The tunnel's SOCKS5 address (Nym's loopback port, or the person's own address) and, through it, public peers by TCP (the IPFS node's resolver among them), resolvers by UDP port 53 and the DNS-over-HTTPS endpoints over TLS; the node's API listener on loopback | A routed local node's whole network: its dials, datagrams and name lookups | **Routed.** Nothing here opens a direct socket or asks the system resolver; a tunnel that is gone refuses every call, and a name DNS-over-HTTPS cannot answer stays unresolved |
| `src/protocols/verifier-host/entry.ts` | Through Electron's `net` in the verifier host: gateways, execution and consensus RPCs, DNS-over-HTTPS, name-service and CCIP-Read hosts, the Swarm and IPFS endpoints | Resolving `.eth` names and reading `ipfs://`, `ipns://` and `bzz://` | Tunnelled while the whole browser is on it: `app.setProxy` points the host at the shared front and the host fetches with `net.request`, signing in itself, resolving no name here; the host restarts when the setting flips, so its direct routes stand down. **The exception** is the Ethereum light client and CCIP-Read when "Use tunnel to run network nodes" is off and no proxy of the system's own applies: they leave through `outside-fetch.ts`'s fetch, outside the tunnel, with the names resolved here by the system's resolver (T86). **The other exception** is a server the light client's config names local (on this computer or the home network): `local-rpc-fetch.ts`'s Node sockets, on every route. Not routed otherwise: the default proxy only, for every website but one in the tunnel profile. While the name relay runs (it does not in this build), the check of a CCIP-Read host judges the addresses main's relay lookup gives, asked of main for each check in place of the system's resolver (`relayed-addresses.ts`); the request itself leaves as the host's other requests do. A tunnel-profile website's fetches never use `net`: they are `routed-fetch.ts`'s |
| `src/protocols/nym-tunnel/dns.ts` | Name lookups of a tunnel as datagrams (type A, then AAAA) sent through that tunnel's own UDP to `8.8.8.8`, with `1.1.1.1` after a quiet spell | The Nym host's SOCKS5 server, for every stream it opens by name | The tunnel's own way out, as `socks-server.ts`: the resolver is reached through Nym and sees the exit, and this computer resolves nothing An onion name never reaches it: `nym-provider.ts` in main refuses one before the tunnel is asked for. |
| `src/protocols/nym-tunnel/module-net.ts` | Nym's directory (`https`) and gateways (`wss`) at public unicast addresses only: every address a name has is checked, at the dial, and any scheme but `https:` is refused (a redirect is followed only to another address that passes the same checks) | The Nym module's `fetch` and `WebSocket`, the only network its process has | The tunnel's own way out |
| `src/protocols/nym-tunnel/service.ts` | Nothing of its own: puts `module-net.ts`'s `fetch` and `WebSocket` in the process's globals for the module | Loading the Nym module | The tunnel's own way out, as `module-net.ts` |
| `src/protocols/nym-tunnel/socks-server.ts` | Listens on `127.0.0.1` behind a secret; opens streams and datagrams only through the Nym module, one tunnel per SOCKS5 user name | The SOCKS5 server the tunnel for apps points at when the choice is Nym | Loopback for the listener (the UDP relay takes datagrams only from the port the client declared, on loopback); every stream and datagram it opens is carried by Nym |
| `src/protocols/verifier-host/direct-fetch.ts` | One gateway or CCIP-Read host at an address pinned in advance, over `https`, with TLS checked against the real name; also the request client `routed-fetch.ts` sends through | The DNS-tamper fallback and the pinned CCIP-Read request | Not routed. It runs only when no proxy applies to the host (T31, T40), so never while the whole browser is on the tunnel, and never for a tunnel-profile website |
| `src/protocols/verifier-host/local-rpc-fetch.ts` | A server the Ethereum light client's config names local, at `localhost` or a loopback, RFC 1918 or unique-local address literal, over `http` or `https` (a certificate is checked as any client checks it), on any port; nothing else (a name, a public or link-local address, a non-canonical spelling, credentials in the address and any other scheme are refused before a socket opens) | The light client's execution and beacon requests, and its clock `HEAD`, to a server the person runs on this computer or their home network | **Not routed, on purpose, on every route.** Node sockets read no proxy setting and never the tunnel's front, so a request for a home-network address is never carried to a tunnel exit's own network (T12). It follows no redirect, caps an answer's size and idle time, and is reached only through `lane-fetch.ts`'s split, after `allowlisted` has admitted the origin |
| `src/protocols/verifier-host/outside-fetch.ts` | The Ethereum light client's execution and beacon providers (Orivon's, or those main names in their place, on port 443; a local one goes to `local-rpc-fetch.ts` instead) and a CCIP-Read host, at public unicast addresses this process resolves and checks itself, over `https` with TLS checked against the real name (through `direct-fetch.ts`) | The light client and CCIP-Read while the whole browser is on the tunnel and "Use tunnel to run network nodes" is off | **Not routed, by the person's choice** (T86). Never used for a tunnel-profile website's content, nor for any other request; absent when a proxy the system itself sets applies, and the light client then follows the tunnel |
| `src/protocols/verifier-host/routed-fetch.ts` | A tunnel profile's front on loopback (one fetch for each tunnel), and through it any gateway, execution or consensus RPC (never one named local, which `lane-fetch.ts` sends to `local-rpc-fetch.ts`), DNS-over-HTTPS, name-service or CCIP-Read host a website's name or files need in that profile, over `https` (plain HTTP in a test build's fixture) | Every fetch the verifier host makes for a website in a tunnel's profile: its IPFS blocks and IPNS records from gateways, its DNSLink, its name's proofs and its CCIP-Read answers | Routed: a `CONNECT` to that tunnel's profile front, which opens the stream through that tunnel with the name unresolved, signing in with the profile's credentials; the tunnel down fails the fetch, and no other way is tried. The local IPFS and Swarm nodes serve such a website only when they would not show its address ("Use tunnel to run network nodes" off, or the nodes themselves in the tunnel), and the Ethereum light client proves its name outside the tunnel when that setting is off; a public gateway is read for it only after the person's yes for that load (T86) |
| `src/protocols/verifier-host/light-client/light-client.ts` | Nothing of its own: replaces the host's `globalThis.fetch` with one that sends each light client's requests to that client's own allowlisted fetch (`entry.ts`'s for the shared client, `routed-fetch.ts`'s for the client of each tunnel's websites, every client of which Helios knows by names that resolve nowhere, so no error of Helios can quote an address), and removes `WebSocket`; when the person's own execution servers are named, one `eth_chainId` `POST` to each as the client starts, to drop one that is not mainnet; after Helios refuses a sync for a clock behind the chain, or later when the system clock is set or the client stalls while a lead is lent, it sends one `HEAD` to the origin of each server the client already asks, through the same allowlisted fetch, to read their `Date` header | Helios, the Ethereum light client | As `entry.ts` for the shared client; routed for each tunnel's client |
| `src/protocols/verifier-host/serve/server.ts` | Listens on loopback with TLS | The server every protocol host name resolves to | Loopback |

## Statistics

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/telemetry/runner.ts` | The usage-statistics server, with the person's consent | The two usage reports | Tunnelled while the whole browser is on it (`ownFetch`): the reports go through the tunnel or are not sent. Not routed otherwise |

## Onion addresses

An onion address (`.onion`, RFC 7686) is carried by the person's own SOCKS5 tunnel and by nothing else, because that tunnel
passes the name on unresolved and a resolver that is asked for one learns which hidden service the person is about to visit
([T89](security-model.md)). Every other way out refuses it before a name is looked up, with the reason in words
(`ONION_NEEDS_TOR`, `src/broker/route/onion.ts`):

| Way out | What it does with an onion address |
|---|---|
| A session's requests (a page, a subresource, a WebSocket, in the default session, a website's profile, an app's session, a temporary routed tab) | `route-subsystem.ts` cancels the request unless the session goes through the person's own SOCKS5 tunnel (`onion-guard.ts`), and the sheet over the tab says why. The embed session and the internal-pages session register their own request listeners and do not take this guard (the last row covers them) |
| A route to Nym (an app's `connect` and datagrams, a page through the front) | `nym-provider.ts` refuses it as `unreachable` before the host is asked for; the Nym host's own lookup is therefore never asked for an onion name |
| Orivon's own requests (`ownFetch`) | Refused unless the request leaves through the tunnel of the person's own SOCKS5 address (`own-requests.ts`) |
| An unrouted app's `orivon.net` | `chromium-resolver.ts` refuses the name before Chromium's resolver is asked |
| A tab icon | `favicon-fetch.ts` fetches an icon at an onion address only for a routed page |
| The verifier host's CCIP-Read and DNSLink lookups | `egress.ts` refuses a CCIP-Read address at an onion name, and `dnslink.ts` asks for no record of one, so neither a resolver nor a DNS-over-HTTPS server hears of the name |
| Any name Chromium would resolve itself, from any session, process or code path | The `--host-resolver-rules` switch ends with clauses that find no onion name (`resolver-rules.ts`), after the rules already given. A request that goes through a proxy is not resolved here at all, so a name sent on to the person's own SOCKS5 tunnel is unaffected. This is the floor under the rows above, and covers the embed session and the internal-pages session, which register their own request listeners and take no guard |

## Names the verifier serves, behind a proxy the system sets

A name the verifier serves (`.eth`, any other top-level domain a protocol serves, and `.orivon`) is answered on this
computer: the resolver rules send it to the verifier's loopback server. Those rules bind Chromium's own resolution
only; a proxy is asked before the resolver is. The default session and a website's own session are given the suffixes as a
bypass at their front when they are on a tunnel; an app's routed session, a temporary routed tab and the requests made with no
session are given the root-dot spelling alone (below), and send the name itself to the front, which is the person's own
tunnel and not the system's proxy. A session that follows the system's proxy cannot
be given a bypass list (`{ mode: 'system' }` takes none), so the proxy would be asked to carry `CONNECT name.eth:443`, would
learn the name, and could answer a plain `http://name.eth/` with a page of its own that loads under the `.eth` address (the
HTTPS-only upgrade leaves these names alone, and no certificate exists to refuse). Three things keep the names from it
([T90](security-model.md)):

- **A proxy of the environment (Linux, no desktop proxy setting).** Before Chromium starts, `src/main/verifier/no-proxy.ts`
  appends `.suffix` for every routed suffix to `no_proxy` and `NO_PROXY`, after whatever the person wrote. Chromium then
  resolves those names direct. A program Orivon starts inherits the variable, including one opened with `openExternal` or
  `openPath`, and asks no proxy about these names either. `no_proxy` does not apply to a proxy found with a script (`auto_proxy`,
  which Chromium reads before the manual variables and which wins over them): that script is copied, as the proxy-script item below says.
- **A manual proxy in GNOME's settings (and the desktops that share them).** `src/main/route/proxy-mirror/` reads the settings
  (`gsettings list-recursively org.gnome.system.proxy`, run without a shell, three seconds at most, its output never logged) and
  sets every session that would follow the system to the same servers and exceptions, plus `*.suffix` for every
  routed suffix in both spellings (`*.eth` and `*.eth.`), so Chromium resolves those names direct, and the root-dot spelling
  (`name.eth.`) fails there as not found, because the resolver rules refuse it. A copy reaches a session only after `orivon-system-check`, a session of the
  mirror's own set to it, answers as `orivon-system-proxy` (Chromium's own answer, never leaving `{ mode: 'system' }`) does for
  two ordinary addresses and up to three the system's exceptions cover; a difference, read again at once, leaves every session
  on `{ mode: 'system' }`. Settings that name detection, cannot be carried exactly or cannot be read stay on it
  too, but a copy already applied outlasts a read that failed, or a check that got no answer, while Chromium's answers for the two
  ordinary addresses are what they were when it passed. The settings are read every thirty seconds and Chromium's answer asked every two.
- **A manual proxy in KDE's settings.** The same copy, read from the `kioslaverc` files Chromium reads (`$HOME/.config`, the
  `XDG_CONFIG_DIRS` below it, or `$KDEHOME/share/config`; a file read of at most a megabyte, three seconds at most, nothing run and
  nothing logged). Its hostname exceptions are turned into the suffix matches Chromium makes of them, since `setProxy` makes none.
  Reversed exceptions and environment-variable names stay on `{ mode: 'system' }`.
- **A manual proxy in Windows' settings.** The same, reading the registry with `%SystemRoot%\System32\reg.exe` (three `query` calls
  run without a shell, three seconds at most, the output never logged): the per-user Internet Settings key, its
  `DefaultConnectionSettings` blob, and the machine policy `ProxySettingsPerUser`, which makes the settings `unsupported`.
  `ProxyServer` and `ProxyOverride` are copied as written, `<local>` included, by the rule Chromium's reader follows
  (`proxy-mirror/README.md`). A proxy found by detection beside a manual one is copied and left to the check.
- **A manual proxy in macOS's settings.** The same copy, read from `/usr/sbin/scutil --proxy` (run without a shell, three seconds at
  most, its output never logged): the web, secure web and SOCKS servers that are switched on, the SOCKS one as SOCKS5, and the
  exceptions as listed, with `<local>` first when "Exclude simple hostnames" is ticked. Automatic discovery alone stays on
  `{ mode: 'system' }`; a script, even beside a manual proxy, is the next item's. Nothing is read or run on other desktops.
- **A proxy script in the system's settings.** GNOME's `autoconfig-url`, KDE's `Proxy Config Script`, Windows' `AutoConfigURL` (or the
  script of the connection blob), macOS's `ProxyAutoConfigURLString` and, on a desktop Chromium reads no proxy settings of its own for,
  the environment's `auto_proxy` (read once, as Chromium reads it) name one. `proxy-mirror/pac-fetch.ts` fetches its text from
  that address alone, and `pac-wrapper.ts` makes of it a script of Orivon's own that answers `DIRECT` for every name the verifier serves
  (any case, any number of root dots) before the system's text runs, and runs that text where it can neither reach that check
  nor replace the function Chromium asks; a text that fails to compile or throws answers `DIRECT`, as Chromium's own session does. The wrapped script
  goes to `orivon-system-check` first and reaches the other sessions only after it answers as `orivon-system-proxy` does for the two ordinary
  addresses; a script whose answers differ at every question, and one that cannot be fetched (no answer, not `http:` or `https:`, over a
  megabyte), leave the sessions on `{ mode: 'system' }`, where the guard decides. The script is fetched again when the settings name
  another address, when Chromium's answers change, and every half hour; Chromium's own session is asked to read it again when the text
  changed (`proxy-mirror/README.md`).
- **Any session that follows the system.** `src/main/route/verifier-name-guard.ts` is registered on the default session and
  on every website session the runtime announces (`forEachWebsiteSession`: the tunnel, proxy and direct profiles and a
  temporary routed tab), through the shared request owner, for `http`, `https`, `ws` and `wss`: its filter lists the four schemes under
  every host and `namesVerifierHost` selects, so the guard rests on no other handler's filter and on no matcher's treatment of
  trailing dots. A session on a tunnel, or held
  shut, is not the system's to answer for and is skipped; a session whose proxy is being set counts as following the system,
  since the tunnel recorded for it may not be the one it has. For a request to a name the verifier serves, the guard:
  1. waits until no change of the session's proxy is under way (ten seconds at most);
  2. cancels a request for plain `http:` or `ws:` whatever the session says, except for the developer names of a run that
     serves them (`isDevEthName`): the verifier answers TLS only, so such a request never reached a page, and a proxy
     auto-configuration script is shown the whole URL of a plain request, which the question the guard asks (it has no path)
     cannot repeat;
  3. asks `session.resolveProxy` for the origin and cancels the request unless the answer is exactly `DIRECT`. The answer is
     never kept: only asks that overlap share one question, and an answer asked across a change of the session's proxy is
     asked again (three times at most);
  4. cancels the request when the session does not say within fifteen seconds, which is long enough for a proxy found by
     automatic detection or a script, or when anything in the check throws. A held request is never sent.

  The requests Orivon makes itself ask the same question first and fail with the same words: the loader's reads, a tab icon,
  the Web3 Score provider and the fetch of the system-mirror session (`direct-fetch.ts`). So does the session of an app shown
  in a `<webview>`, unless the app is routed. A main-frame load that is cancelled shows a sheet (`load-refusals.ts` holds why):
  one that says the system proxy would have seen the name, one that says Orivon could not tell whether it would, and one that
  says the name opens over https only; a line a minute of each kind in the log says so too, without the name.

**Not guarded.** The requests made with no session (`app.setProxy`'s) and those of a utility process are not asked about
beforehand; this build makes none of them for a name the verifier serves. The session that shows a saved local page and an
app's child host are not website sessions, so a name those ask for is not asked about either. A request Orivon makes itself
is asked about at its first address only, so a redirect to such a name from a provider the person chose is not caught at
that hop (a tab icon is, since it follows redirects one by one).

**What remains for `https` and `wss`.** A script that answers the same host differently from one call to the next (by the
time, by a counter, by load) can send the request to a proxy after the guard was told `DIRECT`. The proxy then learns the
name from `CONNECT name.eth:443`; it holds no certificate that would be accepted for it, so it cannot serve a page under the
name. This is the whole of what the guard leaves open for these schemes, and it needs a script written that way.

**What this leaves.** Behind a proxy that macOS settings provide, or KDE settings with reversed exceptions, a name the verifier serves does not
open while the proxy would carry it, and the sheet says why. Adding the routed suffixes (`*.eth` and the rest) to the proxy's
exceptions opens them ([`known-limitations.md`](../known-limitations.md)).

## The root-dot spelling of a name the verifier serves

A name written with the DNS root dot (`vitalik.eth.`) is a host of its own to Chromium. The resolver rule `MAP *.eth` and a
proxy's bypass rule `*.eth` do not match it, and the verifier does not serve it. Left alone, Chromium would look it up with
its own resolver (DNS-over-HTTPS or the system's), or send it to a proxy, a tunnel's front or its far end (`CONNECT
vitalik.eth.:443`), and the name would leave this computer ([T92](security-model.md)). Every way out refuses it, and each
rule is generated from the same list of routed suffixes as the rules for the dotless name:

| Way out | What it does with a root-dot name |
|---|---|
| Any name Chromium would resolve itself, from any session, process or code path | The `--host-resolver-rules` switch ends with `MAP *.suffix. ~NOTFOUND` and `MAP *.suffix..* ~NOTFOUND` for every routed suffix (`resolver-rules.ts`), after the rules already given, as for onion names; the second finds a host with more than one trailing dot, an empty label no valid name has. Neither matches the dotless spelling, which keeps `MAP *.suffix` to the verifier. This is the floor under the rows below |
| A session pointed at a front, and the requests made with no session while the whole browser is on a tunnel | The bypass rules carry `*.suffix.` (`rootDotBypass`, and `sharedBypass` and a website's `bypass` in both spellings: `route-subsystem.ts`, `route-controller.ts`), so the name goes direct and fails as not found. An app's routed session, a temporary routed tab and the requests made with no session carry the root-dot spelling alone |
| A front, asked for a root-dot name anyway | `front.ts` answers 403 and never asks the route, however many dots the host ends in: no bypass list names more than one, and Chromium keeps `vitalik.eth..` as a host of its own, so a session that sends it to the front would otherwise hand it to the route's far end |
| A session that follows the system | `namesVerifierHost` names the root-dot spelling too, so the guard above cancels the request while the session's proxy would carry it; a request the proxy answers `DIRECT` for meets the resolver clause, as every one does behind a proxy Orivon copies from the system's settings, whose exceptions carry `*.suffix.`, or whose wrapped script answers `DIRECT` for the name with any number of root dots |
| The verifier host's CCIP-Read fetch | `egress.ts` refuses a CCIP-Read address at a root-dot name (`namesThisComputer`), with or without a proxy and through a tunnel, so neither the system's resolver nor the tunnel's far end is asked |
| A server address typed in Settings, a manifest's host | Refused: a trailing dot is not an address of a server on the internet, and a host with one is not a bare host name |
| An app's `orivon.net` | The broker reads the root dot away and asks Chromium's resolver (`chromium-resolver.ts`), which the clause above covers |
| Orivon's own requests (`request-fetch.ts`, `direct-fetch.ts`, `routed-fetch.ts`, `own-requests.ts`, the loader's reads, a tab icon, the Web3 Score provider) | They go through a session, so the bypass rules and the clause above apply; the ones that ask first whether a proxy would carry a name (`refuseWhenProxySees`) do so for the root-dot spelling too |

[`e2e-eth-root-dot-names`](../../test/web3/e2e-eth-root-dot-names.test.ts) proves it from Chromium's own net log.

## What the scan cannot see

- **Chromium's own network stack.** Pages, their subresources, WebSocket, WebRTC, service workers and extensions do
  not appear above: they take the proxy of the session they run in. A routed app's sessions, the tunnel profile and a
  temporary routed tab point at a front; the default session and every other session the runtime creates do too while the
  whole browser is on the tunnel (a session is stopped when it is made, on the dead end, and then pointed at the shared front,
  unless its maker claims it: a web context confines itself harder; every session that registers through the shared request owner also refuses the main-frame load of a
  website that belongs in another session). The direct profile and the session that asks what the system's
  proxy is stay on the system's. The person's extensions are part of this: a copy of each runs in the default session, one in
  the tunnel profile and one in the direct profile, and each copy's requests (its background page, its worker, a blocker's
  list updates, a popup) take the proxy of the session it runs in. The tunnel profile's copies are always tunnelled. The direct
  profile's copies are loaded only while a website the person left out of the tunnel is open in it and removed when the last
  one closes, so with the whole browser on the tunnel no extension makes a direct request while no such website is open. The
  engine also makes requests of its own with no web contents (the spellcheck
  dictionary download is one); those take the default proxy, and whether `app.setProxy` reaches them is not measured:
  Step 0 measured the requests a utility process makes with `net`, not the engine's own.
- **A program Orivon starts.** Anything a spawned process dials is that process's own business.
- **Code that passes `fetch` in.** The gateways, IPFS, Swarm and ENS readers and the loader's bundle reader receive a
  `fetch`; the file that builds it is the row above (`entry.ts`, `loader/electron/fetch.ts`).
- **The local nodes' guest code.** What a WebAssembly node does with its sockets goes through `node-net.ts`.
