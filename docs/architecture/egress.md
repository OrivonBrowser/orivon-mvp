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

A routed origin is an installed app the person switched on in its card, a website with an `on` entry (it lives in the
tunnel profile), or, while the whole browser is on the tunnel, any app or website with no entry of its own
([`ADR-0082`](../decisions/ADR-0082-a-websites-tunnel-state-is-kept-per-origin-and-a-website-that-differs-from-the-default-has-storage-of-its-own.md),
[`ADR-0084`](../decisions/ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md));
every other app and website is *not routed*.

## The broker's sockets (durable)

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/broker/adapters/node-adapters.ts` | Any TCP host:port the broker's checks allow; the system resolver | An unrouted app's `orivon.net.connect`, `listen` and `lookup`; the local nodes | Not routed. A routed app never gets here: the broker uses the route's provider for it |
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
| `src/loader/electron/fetch.ts` | The address of an app: its manifest, bundle and update, over `https`; `.eth` and IPFS addresses through the verifier's loopback server | Installing, loading and checking an app | Tunnelled while the whole browser is on it: `net.request` in the default session, which is then the tunnel's, signing in to its front, with no name resolved here, after the sessions follow the setting (bounded wait, then refused); an app set to off goes on the system's proxy. Not routed otherwise, except that a website with its tunnel on is fetched in the tunnel profile's session (its app manifest, its files), and a routed app's update check is paused instead |
| `src/loader/electron/request-fetch.ts` | Whatever the caller asks for, with `net.request`, through the session it is handed, or the process's own network context in a utility process | One `fetch` that signs in to the tunnel's front itself, because `net.fetch` and `Session.fetch` raise no `login` event for a request without web contents | The way Orivon's own requests, the verifier host and the Reader view's pictures take the tunnel: the Reader fetches in the source tab's session, so a picture is routed in a temporary routed tab, a tunnel-profile tab and the default session while the whole browser is on the tunnel, and not routed otherwise; it reaches only where its caller points it |
| `src/loader/reach/reach.ts` | The `https` hosts an app is granted (images, fonts, media, workers, `fetch`), by Node `https` with no session | The third-party requests an app's pages make; a web context's `https` | Routed: for a routed app the connection is TLS over the route's stream with no local name lookup. Not routed otherwise, after the T12 address check |

## The main process

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/main/browsing/favicon-fetch.ts` | The site a tab shows, and the host that holds its icon | A tab's icon, fetched by main | Routed for a routed app, a website with its tunnel on (its profile's or the default session's) or a temporary routed tab (the lookup session). A website set to off while the whole browser is on the tunnel is looked up about on the system's proxy; not routed otherwise |
| `src/main/browsing/score-provider-client.ts` | The Web3 Score provider the person chose | The page's judged level, by hash bucket | Routed for a routed app's or tunnelled website's page (`fetchThroughRoute`; with the whole browser on the tunnel the Web3 reads that cannot go through a session ride the verifier host's tunnelled fetch). A website set to off while the whole browser is on the tunnel is asked about on the system's proxy; a lookup about no origin (an install, an update check) follows the default, through the tunnel while the whole browser is on it (`ownFetch`). Not routed otherwise |
| `src/main/children/child-host.ts` | The app's own session: the pin, and `reach` for a third-party `https` | Serving an app's child host document and files | Takes the app's route, since its session is pointed at the app's front |
| `src/main/consent/grant-prompt-origin.ts` | Nothing: uses only `isIP` | Writing an origin for the permission dialog | Loopback |
| `src/main/dev/local-ddoc.ts` | A loopback address or a developer `.eth` name, in developer mode only | Reading the DDOC file a local origin serves | Loopback |
| `src/main/diagnostics/report-runner.ts` | The usage-statistics server, when the person sends a bug report | Sending the report the person wrote | Tunnelled while the whole browser is on it (`ownFetch`): the report is sent through the tunnel or not at all. Not routed otherwise |
| `src/main/install/app-install-subsystem.ts` | The `https` origin of an app | Reading an app's manifest to ask for its grants without installing it | Tunnelled while the whole browser is on it (`ownFetch`), or on the system's proxy for an app set to off. Not routed otherwise |
| `src/main/local-files/local-partition.ts` | Nothing: reads a `file:` address | Serving a local file in a tab | Loopback |
| `src/main/omnibox/suggest-net.ts` | The person's search engine's suggestion address | Suggestions while typing in the address bar | Tunnelled while the whole browser is on it (`ownFetch`): suggestions come through the tunnel or not at all. Not routed otherwise |
| `src/main/pages/serve.ts` | The renderer's dev server on loopback, in a source run only | Answering an `orivon://` page in development | Loopback |
| `src/main/route/front.ts` | Listens on `127.0.0.1`; opens streams only through the route's provider | The loopback HTTP proxy Chromium is pointed at for a routed app or website | Routed (this is the tunnel's local end) |
| `src/main/route/dead-end.ts` | Listens on a random `127.0.0.1` port, accepts and closes; reads and sends nothing | The place a session is pointed at to stop it (a session made while the whole browser is on the tunnel, one that could not be pointed, the requests made with no session), so a stopped request fails at once and no other listener on this computer is shown a destination name | Loopback |
| `src/main/route/route-controller.ts` | Sets the proxy of an app's or a website's sessions, and of every other session the runtime creates while the whole browser is on the tunnel: the front, or the dead end (the moment a session is made or switched on, before the front is had); also `app.setProxy` for the requests made with no session | Where a session takes the tunnel | Routed (it makes sessions take it) |
| `src/main/route/route-subsystem.ts` | Nothing of its own: wires the sessions, `app.setProxy` and the system-proxy session that T20 and the lookups about a site set to off use | Starting the routes | Routed (it makes the rest take the tunnel) |
| `src/main/self-update/update-check-runner.ts` | GitHub's releases API | Looking for a newer release | Tunnelled while the whole browser is on it (`ownFetch`): the check goes through the tunnel or does not happen. Not routed otherwise |
| `src/main/sessions/web-context-host.ts` | Nothing from the session: its proxy is a port nothing listens on | A web context answers `https` itself (through `reach`), refuses `http` and WebSocket | Takes the app's route through `reach`; the session's proxy only confines it |
| `src/main/settings/proxy-checks.ts` | Nothing: uses only `isIPv6` | Reading a SOCKS5 address | Loopback |
| `src/main/verifier/loopback-port.ts` | A free port on loopback | Choosing the port the verifier's server listens on | Loopback |

## Protocols

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/protocols/local-node/node-net.ts` | Public peers by TCP, DNS resolvers by UDP port 53, through the broker's adapters (a direct node) or through the tunnel (`node-route.ts`); listens on loopback | The local IPFS and Swarm nodes' sockets | Direct unless the whole browser is on the tunnel **and** "Use tunnel to run network nodes" is on, and a direct node does not run while a proxy the system itself sets applies (T20; beside the whole-browser tunnel the question goes to the session that follows the system, not to the tunnel's front). **Routed** when both are on: the process is started with `routed`, its dials, datagrams and name lookups all go through `node-route.ts`, and a node with no route has no network. What a direct node reveals while the tunnel is on is T86 |
| `src/protocols/local-node/service.ts` | The node's DNS-over-HTTPS endpoints with the process's own `fetch` (a direct node) or through the tunnel (a routed one); the node's own API on loopback; the adapters above | Running a local node, naming its peers, and waiting for its readiness | As `node-net.ts`: direct, or routed when the whole browser and the setting are both on; loopback for the readiness check |
| `src/protocols/local-node/node-route.ts` | The tunnel's SOCKS5 address (Nym's loopback port, or the person's own address) and, through it, public peers by TCP, resolvers by UDP port 53 and the DNS-over-HTTPS endpoints over TLS; the node's API listener on loopback | A routed local node's whole network: its dials, datagrams and name lookups | **Routed.** Nothing here opens a direct socket or asks the system resolver; a tunnel that is gone refuses every call, and a name DNS-over-HTTPS cannot answer stays unresolved |
| `src/protocols/verifier-host/entry.ts` | Through Electron's `net` in the verifier host: gateways, execution and consensus RPCs, DNS-over-HTTPS, name-service and CCIP-Read hosts, the Swarm and IPFS endpoints | Resolving `.eth` names and reading `ipfs://`, `ipns://` and `bzz://` | Tunnelled while the whole browser is on it: `app.setProxy` points the host at the shared front and the host fetches with `net.request`, signing in itself, resolving no name here; the host restarts when the setting flips, so its direct routes stand down. **The exception** is the Ethereum light client and CCIP-Read when "Use tunnel to run network nodes" is off and no proxy of the system's own applies: they leave through `outside-fetch.ts`'s fetch, outside the tunnel, with the names resolved here by the system's resolver (T86). Not routed otherwise: the default proxy only, for every website but one in the tunnel profile. A tunnel-profile website's fetches never use `net`: they are `routed-fetch.ts`'s |
| `src/protocols/nym-tunnel/dns.ts` | Name lookups of a tunnel as datagrams (type A, then AAAA) sent through that tunnel's own UDP to `8.8.8.8`, with `1.1.1.1` after a quiet spell | The Nym host's SOCKS5 server, for every stream it opens by name | The tunnel's own way out, as `socks-server.ts`: the resolver is reached through Nym and sees the exit, and this computer resolves nothing |
| `src/protocols/nym-tunnel/module-net.ts` | Nym's directory (`https`) and gateways (`wss`) at public unicast addresses only: every address a name has is checked, at the dial, and any scheme but `https:` is refused (a redirect is followed only to another address that passes the same checks) | The Nym module's `fetch` and `WebSocket`, the only network its process has | The tunnel's own way out |
| `src/protocols/nym-tunnel/service.ts` | Nothing of its own: puts `module-net.ts`'s `fetch` and `WebSocket` in the process's globals for the module | Loading the Nym module | The tunnel's own way out, as `module-net.ts` |
| `src/protocols/nym-tunnel/socks-server.ts` | Listens on `127.0.0.1` behind a secret; opens streams and datagrams only through the Nym module, one tunnel per SOCKS5 user name | The SOCKS5 server the tunnel for apps points at when the choice is Nym | Loopback for the listener (the UDP relay takes datagrams only from the port the client declared, on loopback); every stream and datagram it opens is carried by Nym |
| `src/protocols/verifier-host/direct-fetch.ts` | One gateway or CCIP-Read host at an address pinned in advance, over `https`, with TLS checked against the real name; also the request client `routed-fetch.ts` sends through | The DNS-tamper fallback and the pinned CCIP-Read request | Not routed. It runs only when no proxy applies to the host (T31, T40), so never while the whole browser is on the tunnel, and never for a tunnel-profile website |
| `src/protocols/verifier-host/outside-fetch.ts` | The Ethereum light client's execution and beacon providers and a CCIP-Read host, at public unicast addresses this process resolves and checks itself, over `https` with TLS checked against the real name (through `direct-fetch.ts`) | The light client and CCIP-Read while the whole browser is on the tunnel and "Use tunnel to run network nodes" is off | **Not routed, by the person's choice** (T86). Never used for a tunnel-profile website's content, nor for any other request; absent when a proxy the system itself sets applies, and the light client then follows the tunnel |
| `src/protocols/verifier-host/routed-fetch.ts` | The tunnel profile's front on loopback, and through it any gateway, execution or consensus RPC, DNS-over-HTTPS, name-service or CCIP-Read host a tunnel-profile website's name or files need, over `https` (plain HTTP in a test build's fixture) | Every fetch the verifier host makes for a website in the tunnel profile: its IPFS blocks and IPNS records from gateways, its DNSLink, its name's proofs and its CCIP-Read answers | Routed: a `CONNECT` to the profile's front, which opens the stream through the tunnel with the name unresolved, signing in with the profile's credentials; the tunnel down fails the fetch, and no other way is tried. The local IPFS and Swarm nodes serve such a website only when they would not show its address ("Use tunnel to run network nodes" off, or the nodes themselves in the tunnel), and the Ethereum light client proves its name outside the tunnel when that setting is off; a public gateway is read for it only after the person's yes for that load (T86) |
| `src/protocols/verifier-host/light-client/light-client.ts` | Nothing of its own: replaces the host's `globalThis.fetch` with one that sends each light client's requests to that client's own allowlisted fetch (`entry.ts`'s for the shared client, `routed-fetch.ts`'s for the client of tunnel-profile websites, which Helios knows by names that resolve nowhere), and removes `WebSocket` | Helios, the Ethereum light client | As `entry.ts` for the shared client; routed for the tunnel-profile client |
| `src/protocols/verifier-host/serve/server.ts` | Listens on loopback with TLS | The server every protocol host name resolves to | Loopback |

## Statistics

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/telemetry/runner.ts` | The usage-statistics server, with the person's consent | The two usage reports | Tunnelled while the whole browser is on it (`ownFetch`): the reports go through the tunnel or are not sent. Not routed otherwise |

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
