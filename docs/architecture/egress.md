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
- **The tunnel's own way in.** Connects to the person's SOCKS5 address, the one place a connection is direct by
  definition.
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
| `src/broker/route/socks5.ts` | The person's SOCKS5 address (TCP, and the UDP relay it names) | The route provider every routed path uses | The tunnel's own way in |
| `src/broker/route/socks5-probe.ts` | The person's SOCKS5 address | The Settings page's Test: the greeting only, no stream | The tunnel's own way in |
| `src/broker/transport/ipc.ts` | Through the adapters above | Gives the broker its dial, TLS, UDP, listen and resolve functions, and the question "does a proxy apply?" (T20), asked of a session that only follows the system, never of the default session | Not routed for an unrouted app, which is refused unless the system has no proxy for the destination; a routed app is not asked. An app set to off while the whole browser is on the tunnel is such an app: its answer is the system's |

## The loader: apps, their files and the third parties they load

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/loader/electron/fetch.ts` | The address of an app: its manifest, bundle and update, over `https`; `.eth` and IPFS addresses through the verifier's loopback server | Installing, loading and checking an app | Tunnelled while the whole browser is on it: `net.request` in the default session, which is then the tunnel's, signing in to its front, with no name resolved here; an app set to off goes on the system's proxy. Not routed otherwise, and a routed app's update check is paused instead |
| `src/loader/electron/request-fetch.ts` | Whatever the caller asks for, with `net.request`, through the session it is handed, or the process's own network context in a utility process | One `fetch` that signs in to the tunnel's front itself, because `net.fetch` and `Session.fetch` raise no `login` event for a request without web contents | The way Orivon's own requests, the verifier host and the Reader view's pictures take the tunnel: the Reader fetches in the source tab's session, so a picture is routed in a temporary routed tab, a tunnel-profile tab and the default session while the whole browser is on the tunnel, and not routed otherwise; it reaches only where its caller points it |
| `src/loader/reach/reach.ts` | The `https` hosts an app is granted (images, fonts, media, workers, `fetch`), by Node `https` with no session | The third-party requests an app's pages make; a web context's `https` | Routed: for a routed app the connection is TLS over the route's stream with no local name lookup. Not routed otherwise, after the T12 address check |

## The main process

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/main/browsing/favicon-fetch.ts` | The site a tab shows, and the host that holds its icon | A tab's icon, fetched by main | Routed for a routed app, a website with its tunnel on (its profile's or the default session's) or a temporary routed tab (the lookup session). A website set to off while the whole browser is on the tunnel is looked up about on the system's proxy; not routed otherwise |
| `src/main/browsing/score-provider-client.ts` | The Web3 Score provider the person chose | The page's judged level, by hash bucket | Routed for a routed app's or tunnelled website's page (`fetchThroughRoute`; with the whole browser on the tunnel the Web3 reads that cannot go through a session ride the verifier host's tunnelled fetch). A website set to off while the whole browser is on the tunnel is asked about on the system's proxy; not routed otherwise |
| `src/main/children/child-host.ts` | The app's own session: the pin, and `reach` for a third-party `https` | Serving an app's child host document and files | Takes the app's route, since its session is pointed at the app's front |
| `src/main/consent/grant-prompt-origin.ts` | Nothing: uses only `isIP` | Writing an origin for the permission dialog | Loopback |
| `src/main/dev/local-ddoc.ts` | A loopback address or a developer `.eth` name, in developer mode only | Reading the DDOC file a local origin serves | Loopback |
| `src/main/diagnostics/report-runner.ts` | The usage-statistics server, when the person sends a bug report | Sending the report the person wrote | Tunnelled while the whole browser is on it (`ownFetch`): the report is sent through the tunnel or not at all. Not routed otherwise |
| `src/main/install/app-install-subsystem.ts` | The `https` origin of an app | Reading an app's manifest to ask for its grants without installing it | Tunnelled while the whole browser is on it (`ownFetch`), or on the system's proxy for an app set to off. Not routed otherwise |
| `src/main/local-files/local-partition.ts` | Nothing: reads a `file:` address | Serving a local file in a tab | Loopback |
| `src/main/omnibox/suggest-net.ts` | The person's search engine's suggestion address | Suggestions while typing in the address bar | Tunnelled while the whole browser is on it (`ownFetch`): suggestions come through the tunnel or not at all. Not routed otherwise |
| `src/main/pages/serve.ts` | The renderer's dev server on loopback, in a source run only | Answering an `orivon://` page in development | Loopback |
| `src/main/route/front.ts` | Listens on `127.0.0.1`; opens streams only through the route's provider | The loopback HTTP proxy Chromium is pointed at for a routed app or website | Routed (this is the tunnel's local end) |
| `src/main/route/route-controller.ts` | Sets the proxy of an app's or a website's sessions, and of every other session the runtime creates while the whole browser is on the tunnel: the front, or a rule that reaches nothing; also `app.setProxy` for the requests made with no session | Where a session takes the tunnel | Routed (it makes sessions take it) |
| `src/main/route/route-subsystem.ts` | Nothing of its own: wires the sessions, `app.setProxy` and the system-proxy session that T20 and the lookups about a site set to off use | Starting the routes | Routed (it makes the rest take the tunnel) |
| `src/main/self-update/update-check-runner.ts` | GitHub's releases API | Looking for a newer release | Tunnelled while the whole browser is on it (`ownFetch`): the check goes through the tunnel or does not happen. Not routed otherwise |
| `src/main/sessions/web-context-host.ts` | Nothing from the session: its proxy is a port nothing listens on | A web context answers `https` itself (through `reach`), refuses `http` and WebSocket | Takes the app's route through `reach`; the session's proxy only confines it |
| `src/main/settings/proxy-checks.ts` | Nothing: uses only `isIPv6` | Reading a SOCKS5 address | Loopback |
| `src/main/verifier/loopback-port.ts` | A free port on loopback | Choosing the port the verifier's server listens on | Loopback |

## Protocols

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/protocols/local-node/node-net.ts` | Public peers by TCP, DNS resolvers by UDP port 53, through the broker's adapters; listens on loopback | The local IPFS and Swarm nodes' sockets | Not routed, so the node does not run while a proxy applies, the tunnel for the whole browser included: it dials its peers by address and looks names up with datagrams of its own, which a SOCKS5 tunnel does not carry reliably. The controller refuses it with that reason and IPFS is read through gateways over the tunnel instead |
| `src/protocols/local-node/service.ts` | The node's DNS-over-HTTPS endpoints with the process's own `fetch`; the node's own API on loopback; the adapters above | Running a local node, naming its peers, and waiting for its readiness | Never runs while the whole browser is on the tunnel, as `node-net.ts`; loopback for the readiness check |
| `src/protocols/verifier-host/entry.ts` | Through Electron's `net` in the verifier host: gateways, execution and consensus RPCs, DNS-over-HTTPS, name-service and CCIP-Read hosts, the Swarm and IPFS endpoints | Resolving `.eth` names and reading `ipfs://`, `ipns://` and `bzz://` | Tunnelled while the whole browser is on it: `app.setProxy` points the host at the shared front and the host fetches with `net.request`, signing in itself, resolving no name here; the host restarts when the setting flips, so its direct routes stand down. Not routed otherwise: the default proxy only, and a Web3 name whose website has the tunnel on is tunnelled in part, which the popover and the address bar's key say |
| `src/protocols/verifier-host/direct-fetch.ts` | One gateway or CCIP-Read host at an address pinned in advance, over `https`, with TLS checked against the real name | The DNS-tamper fallback and the pinned CCIP-Read request | Not routed. It runs only when no proxy applies to the host (T31, T40), so never while the whole browser is on the tunnel |
| `src/protocols/verifier-host/light-client/light-client.ts` | Nothing of its own: replaces the host's `globalThis.fetch` with the allowlisted one that calls `entry.ts`'s fetch, and removes `WebSocket` | Helios, the Ethereum light client | As `entry.ts` |
| `src/protocols/verifier-host/serve/server.ts` | Listens on loopback with TLS | The server every protocol host name resolves to | Loopback |

## Statistics

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/telemetry/runner.ts` | The usage-statistics server, with the person's consent | The two usage reports | Tunnelled while the whole browser is on it (`ownFetch`): the reports go through the tunnel or are not sent. Not routed otherwise |

## What the scan cannot see

- **Chromium's own network stack.** Pages, their subresources, WebSocket, WebRTC, service workers and extensions do
  not appear above: they take the proxy of the session they run in. A routed app's sessions, the tunnel profile and a
  temporary routed tab point at a front; the default session and every other session the runtime creates do too while the
  whole browser is on the tunnel (a session is stopped when it is made and then pointed at the shared front, unless its
  maker claims it: a web context confines itself harder). The direct profile and the session that asks what the system's
  proxy is stay on the system's. The engine also makes requests of its own with no web contents (the spellcheck
  dictionary download is one); those take the proxy `app.setProxy` gives them, which is the shared front while the whole
  browser is on the tunnel.
- **A program Orivon starts.** Anything a spawned process dials is that process's own business.
- **Code that passes `fetch` in.** The gateways, IPFS, Swarm and ENS readers and the loader's bundle reader receive a
  `fetch`; the file that builds it is the row above (`entry.ts`, `loader/electron/fetch.ts`).
- **The local nodes' guest code.** What a WebAssembly node does with its sockets goes through `node-net.ts`.
