# Egress: every file that can reach the network, and how it takes the tunnel

**What this page is.** The table of every file in `src/` that opens a socket, resolves a name, makes an HTTP
request or points a session at a proxy, with what it reaches, what it is for, and how it takes the tunnel (the
per-app route of [`ADR-0080`](../decisions/ADR-0080-an-installed-app-can-send-everything-through-one-proxy.md),
threat [T84](security-model.md)). `npm run check:egress` fails CI when a file the scan finds is not a row here, and
when a row names a file that is gone, so a path around the tunnel cannot be added without this page saying so.
[`../planning/tunnel-everywhere-plan.md`](../planning/tunnel-everywhere-plan.md) is where the paths marked *not
routed* are taken through the tunnel.

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
- **Not routed.** Goes direct, or through whatever proxy the system gives the default session. An unrouted app
  or a website keeps this too.

A routed origin is an installed app the person switched on in its card, or a website they turned the tunnel on for from
its site-info popover ([`ADR-0082`](../decisions/ADR-0082-a-websites-tunnel-state-is-kept-per-origin-and-a-website-that-differs-from-the-default-has-storage-of-its-own.md));
every other app and website is *not routed* in this build.

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
| `src/broker/transport/ipc.ts` | Through the adapters above | Gives the broker its dial, TLS, UDP, listen and resolve functions, and the question "does a proxy apply?" (T20) | Not routed for an unrouted app, which is refused unless the default session has no proxy; a routed app is not asked |

## The loader: apps, their files and the third parties they load

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/loader/electron/fetch.ts` | The address of an app: its manifest, bundle and update, over `https`; `.eth` and IPFS addresses through the verifier's loopback server | Installing, loading and checking an app, in the default session | Not routed. A routed app's update check is paused instead |
| `src/loader/reach/reach.ts` | The `https` hosts an app is granted (images, fonts, media, workers, `fetch`), by Node `https` with no session | The third-party requests an app's pages make; a web context's `https` | Routed: for a routed app the connection is TLS over the route's stream with no local name lookup. Not routed otherwise, after the T12 address check |

## The main process

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/main/browsing/favicon-fetch.ts` | The site a tab shows, and the host that holds its icon | A tab's icon, fetched by main | Routed for a routed app, a website with its tunnel on or a temporary routed tab (the lookup session); not routed otherwise |
| `src/main/browsing/score-provider-client.ts` | The Web3 Score provider the person chose | The page's judged level, by hash bucket | Routed for a routed app's or tunnelled website's page (`fetchThroughRoute`; the two reads that cannot go through a session are skipped); not routed otherwise |
| `src/main/children/child-host.ts` | The app's own session: the pin, and `reach` for a third-party `https` | Serving an app's child host document and files | Takes the app's route, since its session is pointed at the app's front |
| `src/main/consent/grant-prompt-origin.ts` | Nothing: uses only `isIP` | Writing an origin for the permission dialog | Loopback |
| `src/main/dev/local-ddoc.ts` | A loopback address or a developer `.eth` name, in developer mode only | Reading the DDOC file a local origin serves | Loopback |
| `src/main/diagnostics/report-runner.ts` | The usage-statistics server, when the person sends a bug report | Sending the report the person wrote | Not routed |
| `src/main/install/app-install-subsystem.ts` | The `https` origin of an app | Reading an app's manifest to ask for its grants without installing it | Not routed |
| `src/main/local-files/local-partition.ts` | Nothing: reads a `file:` address | Serving a local file in a tab | Loopback |
| `src/main/omnibox/suggest-net.ts` | The person's search engine's suggestion address | Suggestions while typing in the address bar | Not routed |
| `src/main/pages/serve.ts` | The renderer's dev server on loopback, in a source run only | Answering an `orivon://` page in development | Loopback |
| `src/main/reader/reader-command.ts` | The hosts of an article's pictures, in the source tab's session | The Reader view's images | Takes the tab's session: routed in a temporary routed tab, not routed otherwise |
| `src/main/route/front.ts` | Listens on `127.0.0.1`; opens streams only through the route's provider | The loopback HTTP proxy Chromium is pointed at for a routed app or website | Routed (this is the tunnel's local end) |
| `src/main/route/route-controller.ts` | Sets the proxy of an app's or a website's sessions: its front, or a rule that reaches nothing | Where a session takes the tunnel | Routed (it makes sessions take it) |
| `src/main/route/routed-fetch.ts` | A GET in the session a routed lookup uses | Tab icons and Web3 Score for a routed app or website, answering the front's proxy challenge | Routed |
| `src/main/self-update/update-check-runner.ts` | GitHub's releases API | Looking for a newer release | Not routed |
| `src/main/sessions/web-context-host.ts` | Nothing from the session: its proxy is a port nothing listens on | A web context answers `https` itself (through `reach`), refuses `http` and WebSocket | Takes the app's route through `reach`; the session's proxy only confines it |
| `src/main/settings/proxy-checks.ts` | Nothing: uses only `isIPv6` | Reading a SOCKS5 address | Loopback |
| `src/main/verifier/loopback-port.ts` | A free port on loopback | Choosing the port the verifier's server listens on | Loopback |

## Protocols

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/protocols/local-node/node-net.ts` | Public peers by TCP, DNS resolvers by UDP port 53, through the broker's adapters; listens on loopback | The local IPFS and Swarm nodes' sockets | Not routed |
| `src/protocols/local-node/service.ts` | The node's DNS-over-HTTPS endpoints with the process's own `fetch`; the node's own API on loopback; the adapters above | Running a local node, naming its peers, and waiting for its readiness | Not routed for the DNS-over-HTTPS lookups; loopback for the readiness check |
| `src/protocols/verifier-host/entry.ts` | Through Electron's `net` in the verifier host: gateways, execution and consensus RPCs, DNS-over-HTTPS, name-service and CCIP-Read hosts, the Swarm and IPFS endpoints | Resolving `.eth` names and reading `ipfs://`, `ipns://` and `bzz://` | Not routed. It takes the default proxy only, also for a Web3 name whose website has the tunnel on: the popover and the address bar's key say the site is tunnelled in part |
| `src/protocols/verifier-host/direct-fetch.ts` | One gateway or CCIP-Read host at an address pinned in advance, over `https`, with TLS checked against the real name | The DNS-tamper fallback and the pinned CCIP-Read request | Not routed. It runs only when no proxy applies to the host (T31, T40) |
| `src/protocols/verifier-host/light-client/light-client.ts` | Nothing of its own: replaces the host's `globalThis.fetch` with the allowlisted one that calls `entry.ts`'s fetch, and removes `WebSocket` | Helios, the Ethereum light client | Not routed, as `entry.ts` |
| `src/protocols/verifier-host/serve/server.ts` | Listens on loopback with TLS | The server every protocol host name resolves to | Loopback |

## Statistics

| File | Reaches | For | Tunnel |
|---|---|---|---|
| `src/telemetry/runner.ts` | The usage-statistics server, with the person's consent | The two usage reports | Not routed |

## What the scan cannot see

- **Chromium's own network stack.** Pages, their subresources, WebSocket, WebRTC, service workers and extensions do
  not appear above: they take the proxy of the session they run in. A routed app's sessions, a routed website's session
  of its own and a temporary routed tab point at a front; the shared session, ordinary tabs and extensions do not. The engine also makes requests of
  its own with no web contents (the spellcheck dictionary download is one); those take the default proxy.
- **A program Orivon starts.** Anything a spawned process dials is that process's own business.
- **Code that passes `fetch` in.** The gateways, IPFS, Swarm and ENS readers and the loader's bundle reader receive a
  `fetch`; the file that builds it is the row above (`entry.ts`, `loader/electron/fetch.ts`).
- **The local nodes' guest code.** What a WebAssembly node does with its sockets goes through `node-net.ts`.
