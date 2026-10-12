# A network route per app: plan

**Need.** The owner asked for it. A person picks one proxy (Tor, or any SOCKS5 proxy, often a
program on the same computer) and turns it on for an installed app. From then on, everything that
app causes to leave the computer goes through that proxy. What the proxy cannot carry is refused,
never sent direct, and if the proxy stops answering, the app's traffic stops with it. The roadmap
lists "Tor and proxy chains" under Later; this is their first step.

**Scope of this step.** Apps served from the cache (installed `.eth` and IPFS apps), because only
they have a session of their own (`persist:app-<hash>`). Ordinary websites share the default
session and are not routed; neither is an app not yet cached. The route is written against a
provider that only has to "open a TCP stream to host:port", and may also send UDP and resolve
names, so another kind of provider plugs in later without changing a caller.

## What exists

- **Broker sockets.** `src/broker/transport/ipc.ts:389-404` wires the broker's `dial`,
  `dialSecure`, `bind`, `listen`, `resolve` and `resolveLookup` to the Node adapters in
  `src/broker/adapters/` (`node-adapters.ts`, `tls-adapter.ts`, `udp-adapter.ts`). The adapters
  never see the app. The capability closures do: `key = canonical(origin)` in
  `src/broker/capabilities/net.ts` (connect at 87, lookup at 190), `net-connect-secure.ts`,
  `net-udp.ts` and `net-listen.ts`. `checkConnect` resolves the name locally before it dials
  (`net.ts:115`, `net-udp.ts:66`). The Swarm node imports the same adapters
  (`src/protocols/swarm-node/node-net.ts`), so they stay as they are.
- **T20** (`docs/architecture/security-model.md`). Every `orivon.net` entry point asks the
  default session whether a proxy applies (`src/broker/transport/proxy-probe.ts`,
  `policy/proxy-guard.ts`) and is `denied` unless the answer is `DIRECT`. That includes loopback
  listens. Unit tests: `src/broker/tests/net-proxy-guard.test.ts`.
- **An installed app's session.** `partitionFor(origin)` (`src/broker/grants/origin-hash.ts:76`).
  `protocol.handle` on it (`src/loader/electron/serve.ts:365-379`) serves same-origin files from
  the pin and sends every other `https` request to `reach`
  (`src/loader/reach/reach.ts:164`, Node `https`, no session, Node's own DNS). A session's proxy
  never applies to a `protocol.handle` response, so `reach` needs its own route. `http:`, `ws:`,
  `wss:`, WebRTC and WebTransport use Chromium's stack in that session, which a session proxy
  does cover, except WebRTC's UDP.
- **The app's other sessions.** Child host `child-host-<hash>` (`src/main/children/child-host.ts`),
  web context `web-context-<hash>-<slot>` (`src/main/sessions/web-context-host.ts`), embeds
  `persist:embed-<hash>` (`src/main/embed/`). The web context already sets a discard-port proxy
  (`web-context-host.ts:210`) and the WebRTC policy `disable_non_proxied_udp` (271), as the child
  host does. Normal app tabs, embeds and popups set neither (A41).
- **Lookups made about an app, outside its session.** Web3 Score (`score-provider-client.ts:147`)
  and tab icons for other hosts (`src/main/browsing/favicon-fetch.ts:209`) use main's `net` on the
  default session. Update checks and name resolution run in the verifier host, a utility process
  with no session (`src/protocols/verifier-host/entry.ts:40`).
- **Settings.** One table, `src/main/settings/schema.ts`; rows in
  `src/renderer/pages/settings/sections/*.ts`. Each app has a card (`apps-view.ts`, IPC in
  `src/main/permissions/apps-domain.ts`). A per-origin store with entries checked at read:
  `src/main/scheme-routing/scheme-choices.ts`.
- **Proxy auth precedent.** `test/sites/e2e-auth.test.ts:77-86,262`: a fixture HTTP proxy that
  answers 407, and the shell answering it.
- **No SOCKS library** in this repository.

## Design

### The route (durable, `src/broker/route/`)

| File | Holds |
|---|---|
| `provider.ts` | `RouteProvider`: `connect(host, port, signal) => Promise<Duplex>`, the name passed unresolved; optional `udp(signal) => Promise<RoutedUdp>` (send a datagram to host:port, receive datagrams); optional `resolve(host, signal)`. A provider error is `unreachable` (`src/contracts/errors.ts`); a missing optional part is `denied` |
| `socks5.ts` | A provider over the `socks` package (MIT, pure JavaScript, Rule 8 passes): CONNECT with the domain name, UDP ASSOCIATE when the proxy accepts it, no `resolve`. Each app sends its own username and password (a hash of its origin, a random value per run), so Tor's default stream isolation gives each app its own circuits. The handshake must also offer no authentication, so a proxy that takes none still works; if `socks` cannot offer both, isolation is off by default (*provisional*, settled by Step 0) |
| `table.ts` | `routeFor(key) => Route \| undefined`. Pure; the store lives in main |

No change to `src/contracts/`: `unreachable` and `denied` already exist. If a new code looks
needed, stop: that is a contracts PR of its own, merged first.

### `orivon.net` for a routed app (durable, `src/broker/capabilities/`)

`CreateBrokerOptions` gains `routeFor`. When it returns a route for the caller's `key`:

- The grant check is unchanged: patterns match the hostname, as now.
- `connect`: no local resolve. An IP literal still passes the T12 address check, then
  `provider.connect`. A hostname goes to the provider as a name.
- `connectSecure`: `node:tls` over the provider's stream, with `servername` the host and the same
  verification options as `tls-adapter.ts`.
- `lookup`: `provider.resolve`, or `denied` when the provider has none.
- `listen` and `udp.bind` with scope `local`: allowed, since loopback never leaves the computer.
  The app's own loopback pages (ADR-0047) and its own media listener (ADR-0069) depend on it.
  Scope `network`: `denied`, because a route gives no address others can reach.
- `udp.send`: a datagram to loopback goes out of the bound socket; any other goes through
  `provider.udp`, or returns `denied`. Inbound datagrams are accepted from the route only.
- T20 is not asked for a routed app: the route is its proxy. An app with no route keeps T20
  exactly as it is.

The adapters are not changed. Tests come first, against a fixture SOCKS5 server in the route's
test support that does CONNECT by name and UDP ASSOCIATE.

### Wiring (tied to Electron, `src/main/route/`)

- **A loopback front per routed app.** A Node `http.Server`: its `connect` event opens every
  tunnel through `provider.connect`, and an absolute-form `http://` request is forwarded over
  the same. The front is HTTP because Chromium cannot authenticate to a SOCKS proxy, and Node
  already has this server. Each front demands its own random `Proxy-Authorization`, answered by
  main's `login` handler for that session only, so no other program or page can use it.
  `proxyRules` never ends in `direct`.
- **The app's sessions.** `setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:<front>' })`
  on its `persist:app-<hash>`, its embeds, and its child host and web contexts (replacing the
  discard-port belt there for a routed app). Loopback stays direct, as Chromium bypasses it on its
  own. When the switch flips: `closeAllConnections()` on those sessions, then reload the app's
  tabs.
- **WebRTC.** `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` on every web contents in
  those sessions, popups included. WebRTC then runs only over TCP relays through the proxy.
- **`reach`.** `reach.ts` takes a connection factory. For a routed origin, `createConnection` is
  TLS over `provider.connect(host, port)`, with no local DNS.
- **Lookups made about a routed app** go through the route or do not happen. Web3 Score and tab
  icons for other hosts are fetched with `session.fetch` on an in-memory session whose proxy is
  the app's front. Update checks and name resolution run in the verifier host and are paused for
  a routed app; its card says so (*provisional*, settled when the verifier host takes a route
  per request).
- **Proxy down.** Requests fail. The site-info popover says the proxy is not answering, and
  nothing goes direct.

### Settings and UI

- **One proxy for the browser.** `network.route.proxy` (SOCKS5 `host:port`) in `schema.ts`, a
  text row in `sections/privacy-network.ts`, and a Test action that runs the SOCKS5 handshake.
- **One switch per app.** `routes.json` in userData, shaped like `scheme-choices.ts`: versioned,
  every entry checked at read. The switch sits on the app's card (`apps-view.ts`), with
  `apps-domain.ts` gaining `setRoute`, its origin checked as `originFromUrl(v) === v`. It is
  disabled, with one sentence saying why, when no proxy is set or the app is not cached.
- **The site-info popover** shows one line for a routed app, and another when its proxy is down.

## Step 0: prove the leak paths closed before building the rest

Through `node scripts/run-headless.mjs`, a probe session with `https` handled by
`protocol.handle` and a proxy set to a local HTTP front:

1. `http://`, `ws://` and `wss://` in that session reach the front, and the target's name is
   never resolved locally (use a name only the front knows).
2. The `login` event answers the front's 407 for that session.
3. Under `disable_non_proxied_udp`, an `RTCPeerConnection` given a STUN server gathers no UDP
   candidate.
4. With the front stopped, every request fails and no direct connection is made.
5. `socks`: CONNECT by name and UDP ASSOCIATE work against the fixture SOCKS5 server, and the
   handshake can offer both no authentication and a username.

**If 1, 3 or 4 fails, stop and report**: the plan changes.

## Tests

- **Unit, written first:** the SOCKS5 provider; every routed broker path (connect,
  connectSecure, lookup, UDP, listen by scope, T20 skipped only for a routed app); the front,
  including a request without its secret refused.
- **End to end:** one spec placed where `test/README.md` says. A cache-served fixture app is
  routed through a fixture SOCKS5 server on `127.0.0.1` that maps names only it knows to local
  fixture servers. It proves that the app's third-party `https` (the `reach` path), WebSocket,
  `orivon.net.connect`, `connectSecure` and a UDP datagram all show up in the SOCKS log and
  succeed. A loopback listen works, a `network` listen is `denied`, and WebRTC gathers no UDP
  candidate. With the SOCKS server stopped, all of it fails and nothing arrives direct. This
  machine answers unknown names with a loopback address, so a direct leak would land on
  loopback: the fixture targets listen on ports only the SOCKS server knows.
- **Catalogue** (`test/app-behaviours/catalogue.md`, section Network):
  `routed-app-sends-nothing-direct`, `routed-app-keeps-its-loopback-listens` and
  `routed-app-refuses-what-the-route-cannot-carry`, plus a `### Changed for apps` line in
  `CHANGELOG.md`.

## Docs

- An ADR (the next free number; renumber if another merges first): an installed app's traffic
  can go through one proxy, and what the proxy cannot carry is refused.
- `security-model.md`: T20 amended for a routed app. A new row for the route, with its residuals:
  - a hostname is resolved by the proxy, so the proxy decides whether a name that points into
    the LAN is reached;
  - update checks are paused;
  - WebRTC runs only over TCP relays;
  - the front listens on loopback, behind its secret.
- A41 narrowed: routed apps get the WebRTC policy.
- `docs/features.md` gains a line. `docs/roadmap.md`: "Tor and proxy chains" stays under Later
  for websites and chains. The compatibility matrix gets a row if its networking table has a
  place for one.

## PRs

1. **`stream/per-app-route-core`:** `src/broker/route/`, the routed broker paths, unit tests and
   the `socks` dependency. No Electron.
2. **`stream/per-app-route`:** the wiring, the settings and UI, the end-to-end spec, the
   catalogue rows and the docs.

Each PR runs `typecheck`, `test:changed`, the `check:*` guards and the specs
`select-e2e.mjs` names. It also gets one `/code-review` and one `/security-review`, since it
crosses the network boundary. The second PR also gets the QA the `orivon-qa` skill names for
UI and boundary changes. After both: `adversarial-reviewer` on the broker and the loader.

## Not in this step

- Ordinary websites: each would first need storage of its own.
- Providers other than SOCKS5: the provider interface is the place they plug in.
- Routing the verifier host per request, so update checks and name resolution can go through
  the route.
- Orivon's own WebRTC and WebTransport for routed apps, so their UDP can go through the route.
  This waits until an app needs it.
- Incoming connections: a route gives no address others can reach.
