# Table 3k: protocol stacks, by the primitive each needs

One part of the [compatibility matrix](../compatibility-matrix.md). The matrix page has this
table in readable form, one row per topic; this page lists every item one by one, for looking up a
single name. It says what works today and nothing else.

The universe is 58 network primitives (`P01` to `P58`, what a transport or service needs from the machine) and the 178 protocol stacks an app is built on (`S001` to `S178`, in seven families), each listed with the primitives it needs. A primitive's detail lives in [Table 1a](table-1-capabilities.md), [Table 1b](table-1-capabilities.md) and [Table 3d](table-3d-network.md), and the rows here only point to it. What a protocol needs (its ports, its upgrade steps, the usual npm package) is general knowledge of the protocol, not a claim about Orivon. Which hosts, ports and addresses a grant admits is the pattern grammar in [Table 1a](table-1-capabilities.md).

## The primitives

| Primitive | Status | What an app gets today |
|---|:--:|---|
| P01 Outbound TCP to a public host | ✅ built | `net.connect` is a real `Duplex` under a `tcp.connect` pattern that names the host. Ports 23, 25, 53, 139, 445, 465, 587, 3389, 6667 and 6697 are reached only when a pattern spells that exact port (P51). [Table 1a](table-1-capabilities.md), [Table 3d](table-3d-network.md) |
| P02 Outbound TCP to a private or LAN host | ⚠️ partial | Only a canonical address literal written in the manifest (at most 256). No subnet, `.local` or "local network" pattern exists; a CIDR string is accepted and matches nothing. [Table 1b](table-1-capabilities.md) |
| P03 Outbound TCP to loopback | ✅ built | `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>` declared; `*` never reaches loopback |
| P04 Outbound to an address chosen at run time | ⚠️ partial | Any public unicast address on any non-reserved port under `*:*`, IPv4 and IPv6. A private peer typed in at run time is unreachable, and `app.requestGrant` only narrows the manifest |
| P05 Implicit TLS (TLS from the first byte) | ✅ built | `tls.connect` is `orivon.net.connectSecure`; the broker does the handshake and the verification. Needs an `https.connect` pattern naming the host. Ports 465 and 6697 need an exact `host:port` pattern |
| P06 STARTTLS, or upgrading an open TCP socket to TLS | ❌ missing | `tls.connect({ socket })` and `new TLSSocket(socket)` refuse by name (A226). No operation upgrades a socket |
| P07 TLS with a client certificate | ✅ built | `cert`, `key`, `pfx` and `passphrase` reach the broker, one PEM string or buffer per option |
| P08 TLS with a custom CA or certificate pinning | ✅ built | `ca` and `rejectUnauthorized: false` are honoured, and the broker then checks every resolved address, so a self-signed device is reachable on a public address or a declared literal and never by a LAN name. A page-side `checkServerIdentity` can pin `fingerprint256` |
| P09 TLS session details (ALPN, SNI, peer certificate) | ⚠️ partial | `alpnProtocols` in; `alpnProtocol`, `authorized`, `authorizationError`, `servername` and `getPeerCertificate()` out. `getProtocol()` is `null` and 16 of 21 `TLSSocket` members read `undefined` ([Table 3d](table-3d-network.md)) |
| P10 TLS policy options (`minVersion`, `ciphers`, `ecdhCurve`, `session`, `crl`, `requestOCSP`, `sigalgs`) | ⚠️ differs | Dropped without an error, so a `minVersion: 'TLSv1.3'` pin is not enforced |
| P11 TLS server | ❌ missing | `tls.createServer` and `https.createServer` refuse by name. `orivon.net.listen` yields plaintext handles only |
| P12 Inbound TCP listen | ✅ built | Needs a declared range starting at 1024, and is IPv4 only. `tcp.listen.network` binds every interface; `tcp.listen.local` binds `127.0.0.1`, which other programs on this computer reach and the network does not ([ADR-0034](../../decisions/ADR-0034-listening-is-local-unless-the-app-declares-the-network.md)). `listen(port)` and `listen(port, '0.0.0.0')` ask for every interface and fall back to loopback when only the local grant is held; `'127.0.0.1'`, `'localhost'` and `'::1'` bind `127.0.0.1`; one other address refuses by name. A real-Electron test listens from a page. [Table 1a](table-1-capabilities.md), [Table 3d](table-3d-network.md) |
| P13 Reachability from the LAN and the internet | ⚠️ partial | A `network` listener is open to every device on the LAN and, where the router forwards the port, to the internet. A `local` listener is reachable only from programs on this computer. There is no port mapping (P39) |
| P14 IPv6 inbound (TCP listen, UDP bind) | ❌ missing | Both bind IPv4 only; `listen(port, '::')`, `listen(port, '::1')` and `createSocket('udp6')` return an IPv4 socket with no error (A218) |
| P15 UDP unicast send and receive | ⚠️ partial | `dgram` `udp4` under `udp.bind.network` plus `udp.send` patterns. A `udp.bind.local` socket is on loopback and can send only to loopback destinations (P16). IPv4 only, 65507-byte datagrams, a refused send reports success. [Table 1a](table-1-capabilities.md), [Table 3d](table-3d-network.md) |
| P16 UDP client with no inbound grant | ❌ missing | Every socket goes through `udpBind`, which needs an inbound grant even for a client that only sends, and there is no send-only socket. `udp.bind.local` is the lighter prompt, but a loopback-bound socket cannot send to a public address (`EINVAL` on Linux, measured with plain Node; other systems not measured), and the shim reports that send as success. A send-only client needs `udp.bind.network` |
| P17 UDP to peers chosen at run time | ✅ built | With a bound socket (P16), `udp.send: ["*:*"]` reaches any public unicast IPv4 address on a non-reserved port (53 only when named exactly) |
| P18 UDP broadcast | ❌ missing | `255.255.255.255` is denied even when named. A directed broadcast literal passes the pattern check, then the operating system refuses it because no code sets `SO_BROADCAST` (measured for `127.255.255.255` with plain Node on Linux); the send counts as a refusal and the `dgram` shim reports success. `setBroadcast` refuses by name |
| P19 UDP multicast join and send | ❌ missing | `addMembership`, `dropMembership`, `setMulticastTTL`, `setMulticastLoopback` and `setBroadcast` refuse by name; a send to a group is dropped and reported as success. The contract records "No multicast in v0" |
| P20 IPv6 outbound (TCP, TLS, AAAA) | ✅ built | AAAA answers in `2000::/3` are dialled; bracketed literals can be declared. Unique-local and link-local addresses need a literal. UDP over IPv6 is P14 |
| P21 Raw sockets and ICMP | 🚫 excluded by design | No API. [`capability-api.md`](../../architecture/capability-api.md) lists raw sockets and ICMP under "Deliberately not in v0": no use case, and unreachable from WebAssembly later |
| P22 Unix domain sockets and Windows named pipes | ❌ missing | `connect({ path })` and `listen({ path })` refuse `not-applicable`; `http.request({ socketPath })` is ignored and dials `localhost:80`. A `TcpSocket` is TCP only. [Table 3d](table-3d-network.md) |
| P23 DNS A and AAAA | ⚠️ partial | `dns.lookup` over `orivon.net.lookup`. The name must be named by a held `tcp.connect` or `udp.send` pattern (`https.connect` does not count), and answers are filtered to public unicast. `hints`, `verbatim` and `order` are ignored |
| P24 DNS SRV, TXT, MX, PTR, NAPTR, CAA and custom resolvers | ❌ missing | The 20 other `dns` functions and `Resolver` refuse by name. Workarounds under a grant: DNS over TCP to a resolver named as an exact literal (`1.1.1.1:53` on `tcp.connect`), DNS over TLS (`1.1.1.1:853` on `https.connect`), DoH by `fetch` to a named host, or DNS over UDP with a bind range (P16) |
| P25 HTTP/1.1 client | ⚠️ partial | `http.request` is a hand-written HTTP/1.1 writer over `orivon.net.connect`: `Connection: close`, no pooling, response trailers dropped. The page's `fetch` and `XMLHttpRequest` are routed the same way, with no CORS, no cookie jar and no HTTP cache. [Table 3d](table-3d-network.md) |
| P26 HTTP/2 client | ❌ missing | `http2` loads and every function refuses by name, `connect` included. `connectSecure` can negotiate `h2`, and nothing frames it. [Table 3d](table-3d-network.md) |
| P27 HTTP/3 and QUIC | ❌ missing | Routed traffic is HTTP/1.1. A QUIC stack would have to be written in JavaScript or WebAssembly over `dgram` (port 443 is not reserved), or use the page's native `WebTransport` (P33) |
| P28 HTTP server | ⚠️ partial | `http.createServer`, `Server`, `ServerResponse` and `OutgoingMessage` are built over `net.Server` on `orivon.net.listen`: keep-alive, chunked bodies both ways, `Expect: 100-continue`, `upgrade` and `connect`, three timeouts. A connection answers one request at a time, and `https.createServer` refuses by name (P11). A real-Electron test serves real clients; `express`, `koa` and `fastify` are run by no test (not measured). Needs a `tcp.listen` grant. [Table 3d](table-3d-network.md) |
| P29 WebSocket client | ⚠️ partial | The page's `WebSocket` is an RFC 6455 client over `connect` and `connectSecure`, with the page origin, subprotocols, no `permessage-deflate`, no custom headers and no options object. The `ws` package's Node build could set headers over the `http` upgrade (not measured) |
| P30 WebSocket server | ⚠️ partial | `ws.Server` takes the `upgrade` event of an `http.Server`, which hands the app the raw socket and the bytes read past the head (unit tests); no test runs `ws` itself (not measured). Hand-written framing over `net.createServer` is the other route. Both need a `tcp.listen` grant |
| P31 Server-Sent Events | ✅ built | The routed `EventSource` handles `retry` and `Last-Event-ID`; a streamed `fetch` reads SSE with custom headers |
| P32 WebRTC (data channels, media, ICE, STUN, TURN) | ✅ built | Chromium's own. No grant bounds it in an app tab (A41, open); only the isolated `web.context` has a discard proxy |
| P33 WebTransport | ⚠️ partial | The page's native API, which the served CSP `connect-src` is meant to bound to the granted `https.connect` hosts. Whether a granted host is reached, and whether certificate hashes are accepted, is not measured |
| P34 SOCKS and HTTP proxy clients | ⚠️ partial | A SOCKS5 or HTTP `CONNECT` handshake spoken by hand over `net.connect('127.0.0.1', 9050)` should work with `localhost:9050` declared, and the proxy then reaches hosts the manifest never named (not measured). `agent-base`, `socks-proxy-agent` and `https-proxy-agent` have no effect, because `Agent#createConnection` is never called. TLS through the tunnel needs P06 or P44 |
| P35 Connections that outlive a hidden or closed tab | ⚠️ partial | A hidden tab keeps its sockets, which live in the main process. When the last document of the origin closes or navigates, the broker drops every socket, listener and UDP socket of the origin. Children the app starts live until its last page closes ([ADR-0046](../../decisions/ADR-0046-an-app-s-children-live-until-its-last-page-closes.md)) |
| P36 Connection count | ⚠️ partial | 512 sockets per origin, 64 by default, raised by manifest `net.concurrentSockets` (the lower of the two applies). 256 operations in flight per origin; a call waits up to 10 s, then fails `limit`. [Table 1a](table-1-capabilities.md) |
| P37 Rate of new connections | ⚠️ partial | `connect`, `connectSecure`, `listen`, `udpBind` and `lookup` share a bucket of 200 burst and 100 a second per origin, and a call over it fails `limit` at once. Each routed `fetch`, `XMLHttpRequest` and `WebSocket` open is one connect |
| P38 Keep-alive and connection pooling | ⚠️ differs | TCP `setKeepAlive` reaches the operating system socket. HTTP keep-alive does not exist on the client: `Connection: close`, one connection per request, and `Agent` options `keepAlive` and `maxSockets` are stored and never enforced. An `http.Server` keeps connections alive (`keepAliveTimeout` 5 s) |
| P39 NAT mapping (UPnP-IGD, NAT-PMP, PCP) | ❌ missing | UPnP needs SSDP multicast (P19). NAT-PMP and PCP are unicast UDP to the gateway, allowed if the manifest names the gateway's literal and a bind range, which the manifest cannot know, and `os.networkInterfaces()` returns `{}` (P42) |
| P40 Hole punching | ⚠️ partial | By the code, UDP to public peers can work: one bound socket sends and receives, and inbound datagrams are accepted from any source address. No hole-punching run exists (not measured). TCP simultaneous open does not work: `connect` ignores `localAddress`, `localPort` and `reuseAddr` |
| P41 Source address, source port and socket options | ⚠️ differs | `localAddress`, `localPort`, `family`, `lookup`, `hints` and `autoSelectFamily` on `connect`, `reuseAddr`, `reusePort` and buffer sizes on `dgram`, and `backlog`, `exclusive`, `ipv6Only` on `listen` are accepted and ignored without an error. `listen(port, host)` and `bind(port, address)` take loopback or every interface and refuse any other address by name. `setTTL` and `connect` on a datagram socket read `undefined` |
| P42 Network interface and address discovery | ❌ missing | `os.networkInterfaces()` returns `{}` with no error. A `RTCPeerConnection` host candidate is the only local-address source ([Table 1b](table-1-capabilities.md)) |
| P43 Sockets from a Worker, an iframe, a `<webview>` or a child process | ⚠️ partial | `window.orivon` and the routed globals exist in a tab's top frame only. A child started by `spawn` or `fork` gets a relayed `orivon`, and a `wasm32-wasip2` program gets `wasi:sockets` TCP and UDP under the same grants, limits and refusals (a loopback bind asks `local`, any other address asks `network`), with no TLS, no multicast and no DNS record types |
| P44 TLS in user space over a plain socket | ⚠️ partial | The plain `tcp.connect` socket carries any bytes, so a JavaScript or WebAssembly TLS stack can do the upgrade itself; no test runs such a library over it (not measured). The broker sees ciphertext on a plain grant, the reserved ports apply, and the trust store is the app's own |
| P45 Electron's own network surface (`net.request`, `net.fetch`, `session.setProxy`, `webRequest`, `protocol.handle`) | ❌ missing | `session` and `protocol` refuse `unimplemented`; `net` is not on the shim's curated list, so a named import fails the build and the default export throws for the name |
| P46 Online and offline signals | ✅ built | The page's `navigator.onLine` and the `online` and `offline` events, which are Chromium's. Node has none |
| P47 Mixed content and private-network access from the page | ⚠️ differs | The routed path lets an `https` page reach a granted `http:` or `ws:` host. A native request from a `.eth` or `ipfs` document is classed as a public-address request (not measured) |
| P48 Checks against DNS rebinding | ✅ built | The broker resolves once, checks every answer and dials the checked literal. `https.connect` with default verification matches the name and does not resolve, so a public name whose record points at a private address is not caught there |
| P49 Ephemeral local ports | ⚠️ differs | `listen(0)` and `bind(0)` pick a random port inside the granted ranges, never an operating-system one; an app with no range to spare fails `limit` after 64 tries |
| P50 Privileged ports (below 1024) for listen and bind | 🚫 excluded by design | Denied outright at every tier, and a range that starts below 1024 is discarded whole ([`capability-api.md`](../../architecture/capability-api.md)) |
| P51 Outbound to ports 23, 25, 53, 139, 445, 465, 587, 3389, 6667 and 6697 | ⚠️ partial | `*:*` and a range never reach them. A single pattern that spells the exact port does: `host:port` for `tcp.connect`, `udp.send` and `https.connect`, and `*:port` for `tcp.connect` and `https.connect`, which reaches any public server on that port, so a server the person types in is reachable. `udp.send` accepts the wildcard host only as `*:*`, so a DNS server typed in stays unreachable (A304) |
| P52 Multicast and broadcast receive | ❌ missing | `udpBind` binds `0.0.0.0` (network scope) or `127.0.0.1` (local scope) and no group can be joined, so only unicast and directed traffic arrives |
| P53 `dns.lookup` for a name that resolves only to a private address | ⚠️ differs | `net.connect('nas.internal', 5000)` succeeds under the literal `192.168.1.50:5000`, because the broker checks the resolved address against the literal. `dns.lookup('nas.internal')` fails `denied` under that literal alone, since an address literal authorises no name, and fails `unreachable` when a `*` or a hostname pattern authorises the lookup and the private answer is filtered out |
| P54 Operating-system proxy (system proxy, PAC) | ⚠️ differs | While a system proxy applies to the destination, every `orivon.net` call is `denied`; the routed `fetch` then falls back to the native path. `HTTP_PROXY` variables are never read |
| P55 Half-open and reset control | ✅ built | `allowHalfOpen`, `end`, `resetAndDestroy`, `setTimeout` and `setNoDelay` on `TcpSocket` |
| P56 Datagram loss visibility | ⚠️ differs | The handle exposes `droppedInbound`, `droppedOutbound` and `refusals`; the `dgram` shim shows none of them, and a refused send reports success |
| P57 Dial and idle timeouts | ✅ built | Dial 30 s per address, one after the other. The routed `fetch` idles for 300 s, a `WebSocket` opens within 240 s and closes within 60 s, and an `EventSource` reconnects after 3 s |
| P58 Egress from a page to an ungranted host | 🚫 excluded by design | A native `fetch`, `WebSocket` or `EventSource` to a host with no grant is refused by the served CSP `connect-src` (WebTransport is P33) ([`security-model.md`](../../architecture/security-model.md) T22) |

## The stacks

A stack reads ✅ built when its ordinary client path runs under the grants named in the row, ⚠️ partial when it runs under a named condition or with a named feature lost, ❌ missing when a primitive it needs is absent (the row names it), and 🚫 excluded by design when the primitive is excluded. Ports, upgrade steps and usual packages are what the protocol needs, not measurements of Orivon. A stack that takes hosts from the person needs `*:*` on `tcp.connect`, `https.connect` or `udp.send`, and a LAN host needs its literal address (P02).

### Peer-to-peer and file sharing

| Protocol or stack | Primitives it needs | Status | What is missing, or the condition |
|---|---|:--:|---|
| BitTorrent peer wire, outbound and inbound TCP (S001) | P01, P04, P12, P36 | ⚠️ partial | Public IPv4 peers work with `tcp.connect: ["*:*"]`, a `tcp.listen.network` range such as `6881-6889` and a raised `concurrentSockets`. LAN peers need literals (P02), IPv6 peers are unreachable (P14), inbound reaches the app only if the person forwards the port (P39), and a closed tab drops every peer (P35) |
| BitTorrent DHT, BEP 5 (S002) | P15, P17 | ⚠️ partial | A `udp.bind.network` range plus `udp.send: ["*:*"]`. IPv4 only, and a refused send reports success, so a blocked peer looks silent |
| BitTorrent UDP trackers (S003) | P15, P17 | ✅ built | `udp.send` naming the tracker or `*:*`, plus a `udp.bind.network` range although only the reply is inbound (P16): a heavier prompt, no lost feature |
| BitTorrent HTTP trackers and web seeds, BEP 19 (S004) | P25 | ✅ built | `https.connect` or `tcp.connect` naming the hosts, `*:*` for ones the person supplies. Range requests go through the routed `fetch` |
| BitTorrent WebSocket trackers (S005) | P29 | ✅ built | `https.connect` for `wss:`. The `Origin` header is the app's own |
| BitTorrent uTP, BEP 29 (S006) | P15 | ❌ missing | The usual package, `utp-native`, is a native addon ([Table 5](table-5-native-modules.md)). A pure-JavaScript uTP over `dgram` would run under the grants of the DHT row |
| BitTorrent peer exchange, PEX (S007) | in-band on S001 | ✅ built | Nothing beyond the peer wire row |
| BitTorrent local peer discovery, BEP 14 (S008) | P19, P52 | ❌ missing | Multicast to `239.192.152.143:6771`: `addMembership` refuses by name and the send is dropped and reported as success |
| BitTorrent port mapping through UPnP-IGD or NAT-PMP (S009) | P39, P19, P42 | ❌ missing | SSDP is multicast (P19), and NAT-PMP needs the gateway literal in the manifest (P39) |
| BitTorrent over WebRTC, the WebTorrent browser build (S010) | P32, P29 | ✅ built | WebRTC is ungated in an app tab (A41). It needs WebSocket trackers for signalling |
| WebTorrent hybrid in Node, `node-datachannel` and `wrtc` (S011) | P32 | ❌ missing | The Node WebRTC packages are native addons ([Table 5](table-5-native-modules.md)). The page's own `RTCPeerConnection` is what the WebRTC row uses |
| libp2p TCP transport (S012) | P01, P04, P12 | ⚠️ partial | Outbound public, and listen on every interface (`tcp.listen.network`) or on `127.0.0.1` (`tcp.listen.local`) under a declared range, work. A listen on one other address refuses by name (P12), and `localAddress` and `reuseAddr` are ignored (P41) |
| libp2p QUIC (S013) | P27, P15 | ❌ missing | No QUIC in the shim (P27), and the usual package is native |
| libp2p WebSockets (S014) | P29 | ✅ built | `https.connect` for `wss:`, `tcp.connect` for `ws:`, `*:*` for peers found at run time. Peers with private multiaddrs are unreachable (P02) |
| libp2p WebTransport (S015) | P33 | ⚠️ partial | The page's native `WebTransport` under a granted host (not measured; P33) |
| libp2p WebRTC and circuit relay v2 (S016) | P32, P29 | ✅ built | The browser configuration of js-libp2p: WebSockets to a relay, WebRTC for the hop |
| libp2p mDNS peer discovery (S017) | P19, P52 | ❌ missing | Multicast |
| libp2p Kad-DHT, AutoNAT, identify and gossipsub (S018) | in-band on the libp2p transports | ✅ built | Over the TCP, WebSocket and WebRTC rows. AutoNAT reports the node as not publicly dialable (P13, P39) |
| IPFS `dnsaddr` and DNSLink resolution (S019) | P24 | ⚠️ partial | The Node build uses `dns.resolveTxt`, which refuses by name. The browser build uses DoH through `fetch`, which works with `https.connect` naming the DoH host |
| IPFS or kubo HTTP RPC and gateway client (S020) | P03, P25 | ✅ built | `localhost:5001` (or the gateway port) declared; a remote gateway under `https.connect` |
| Hypercore and Hyperswarm, HyperDHT over UDP with hole punching (S021) | P15, P17, P40 | ❌ missing | The usual UDP transport, `udx-native`, is a native addon ([Table 5](table-5-native-modules.md)). The DHT is UDP unicast to public peers and would fit the BitTorrent DHT grants, and `@hyperswarm/dht-relay` over WebSocket works |
| Dat discovery-swarm (S022) | P01, P12, P15, P19 | ⚠️ partial | The TCP and UDP legs work. Its local discovery over mDNS needs multicast (P19) |
| Secure Scuttlebutt, SHS and muxrpc on TCP 8008 (S023) | P01, P12, P18 | ⚠️ partial | Pubs and rooms over TCP or WebSocket work. LAN discovery is UDP broadcast on 8008 (P18), and the usual cryptography package, `sodium-native`, is a native addon ([Table 5](table-5-native-modules.md)) |
| GNUnet-style overlay, TCP and UDP with LAN multicast discovery (S024) | P01, P15, P19 | ⚠️ partial | The transport legs work. LAN discovery needs multicast (P19) |
| Syncthing block exchange, TLS 1.3 with device certificates (S025) | P05, P07, P08, P11 | ⚠️ partial | Outbound to public peers works: `cert` and `key` for the device, `rejectUnauthorized: false` and a `checkServerIdentity` that compares `getPeerCertificate().fingerprint256` with the device ID. Inbound needs a TLS server (P11), and LAN peers need a declared literal (P02) |
| Syncthing local discovery, UDP multicast and broadcast on port 21027 (S026) | P18, P19 | ❌ missing | Multicast and broadcast |
| Syncthing global discovery and relays (S027) | P05, P07, P04 | ✅ built | `https.connect` naming the discovery server and `*:*` for relays |
| Nostr relays, NIP-01 over WebSocket (S028) | P29, P04 | ✅ built | `https.connect: ["*:*"]` for relays the person adds, `tcp.connect` for `ws:`. `*:443` is not a declarable pattern |
| Matrix client, HTTPS client-server API with `/sync` long poll (S029) | P25, P05 | ✅ built | The Element port runs it. The routed `fetch` has no cookie jar, so cookie-based sessions do not work |
| Matrix homeserver and federation, inbound HTTPS on 8448 (S030) and ActivityPub server, inbound HTTPS from other instances (S032) | P28, P11, P13 | ❌ missing | `http.createServer` exists (P28) but has no TLS (P11), and nothing opens a port to the internet (P13, P39). Plain HTTP behind a TLS-terminating proxy on the LAN is the route (not measured), as is an outbound-only relay |
| ActivityPub client, HTTPS with signed requests (S031) | P25 | ✅ built | `https.connect` for the instance hosts, `*:*` for ones the person picks |
| Gun peer over WebSocket (S033) | P29 | ✅ built | `https.connect` naming the relay |
| Gun relay peer, HTTP and WebSocket server (S034) | P28, P30 | ⚠️ partial | The HTTP server and the `upgrade` event exist (P28, P30); no test runs the `ws` server (not measured). Other devices reach it only under `tcp.listen.network` |

### Blockchains and wallets

| Protocol or stack | Primitives it needs | Status | What is missing, or the condition |
|---|---|:--:|---|
| Bitcoin P2P, TCP 8333 with DNS seeds (S035) | P01, P23, P12 | ⚠️ partial | Seeds resolve through `dns.lookup` (`resolve4` refuses, P24) under a pattern naming the seed host or `*`. Outbound public IPv4 peers work. Tor and I2P peers need a proxy daemon (see the Tor row) |
| Electrum protocol, plaintext TCP 50001 (S036) | P01, P04 | ✅ built | `tcp.connect` naming the server or `*:*`. A server on the LAN needs its literal (P02) |
| Electrum protocol over TLS 50002, often self-signed (S037) | P05, P08 | ✅ built | `https.connect` naming the server, with `rejectUnauthorized: false` or a `ca` with a pinned fingerprint, on a public address or a declared literal |
| Bitcoin Core JSON-RPC, HTTP to localhost 8332 (S038) | P03, P25 | ✅ built | `tcp.connect: ["localhost:8332"]`. Cookie-file authentication needs a file the app cannot read outside its own root, so `rpcuser` and `rpcpassword` are used |
| Bitcoin Core ZMQ notifications (S039) | P03 | ❌ missing | The usual package, `zeromq`, is a native addon ([Table 5](table-5-native-modules.md)). ZMTP is plain TCP, so a pure-JavaScript client over `net.connect` would fit (none published) |
| Lightning BOLT P2P, TCP 9735 with Noise_XK (S040) | P01, P04, P12 | ⚠️ partial | Outbound to public nodes under `tcp.connect: ["*:*"]`. Onion nodes need a proxy daemon, and inbound needs `tcp.listen.network` and a forwarded port (P39) |
| LND gRPC, HTTP/2 with TLS and a macaroon (S041), Core Lightning gRPC (S045), Zcash lightwalletd over gRPC (S056) | P26, P05, P08 | ❌ missing | `http2` has no HTTP/2 framing (P26) |
| LND REST, HTTPS 8080 with a self-signed certificate (S042) and Core Lightning REST (S046) | P05, P08, P25 | ✅ built | `https.connect: ["localhost:8080"]` (or a declared literal) and Node `https.request` with `ca` or `rejectUnauthorized: false`. The routed `fetch` cannot pass a CA, so it fails a self-signed certificate |
| LND REST WebSocket streams, macaroon in a header or subprotocol (S043) | P29 | ⚠️ partial | The routed `WebSocket` cannot set a header. The macaroon can travel as a subprotocol and the certificate must be publicly trusted |
| Core Lightning over its Unix socket `lightning-rpc` (S044) | P22 | ❌ missing | Unix sockets (P22) |
| LNURL, pay, withdraw and auth over HTTPS (S047) | P25 | ✅ built | `https.connect` for the LNURL hosts (`*:*`). An `.onion` LNURL host needs a proxy daemon |
| Ethereum JSON-RPC over HTTPS (S048) | P25 | ✅ built | `https.connect` naming the RPC host, or `*:*` for an endpoint the person supplies |
| Ethereum JSON-RPC over WebSocket, subscriptions (S049) | P29 | ✅ built | `https.connect` for `wss:` |
| devp2p, RLPx over TCP 30303 and discovery over UDP (S050) | P01, P12, P15, P17 | ⚠️ partial | TCP and UDP to public IPv4 nodes. UDP needs `udp.bind.network`. IPv6 (discv5) nodes (P14) and LAN nodes (P02) are unreachable |
| Ethereum light client, Helios: HTTPS beacon and execution RPC (S051) | P25 | ✅ built | `https.connect` for the beacon and execution endpoints |
| Monero daemon RPC, HTTP with digest authentication on 18081 (S052) and wallet RPC on localhost 18083 (S053) | P03, P25 | ✅ built | `localhost:18081` or `localhost:18083` declared; a remote node under `tcp.connect` or `https.connect`. The wallet process is native and the person starts it |
| Monero over Tor (S054) | P34, P06 | ⚠️ partial | `socks-proxy-agent` is never called (P34). A hand-written SOCKS5 handshake with `http.request({ createConnection })` works for plain HTTP. HTTPS to the node needs an upgrade over the tunnel (P06, P44) |
| Monero P2P, Levin over TCP 18080 (S055) | P01, P12 | ⚠️ partial | The TCP legs are those of the BitTorrent peer wire row |
| Zcash lightwalletd over gRPC-web (S057) | P25 | ✅ built | The gRPC-web frame carries its trailers in the body, so HTTP/1.1 and a streamed routed `fetch` are enough. The server must offer gRPC-web |
| Cosmos and Tendermint RPC, HTTP and WebSocket (S058) | P25, P29 | ✅ built | `https.connect` for the RPC host |
| Solana JSON-RPC and WebSocket (S059) | P25, P29 | ✅ built | `https.connect` for the RPC host |
| Polkadot API, WebSocket JSON-RPC (S060) | P29 | ✅ built | `https.connect` for the node |
| smoldot light client, WebSocket or WebRTC to peers (S061) | P29, P32 | ✅ built | Runs as WebAssembly in the page. Peers over `wss:` need `https.connect: ["*:*"]`, and WebRTC is ungated (not measured) |
| THORChain, Midgard and THORNode over HTTPS (S062) | P25 | ✅ built | `https.connect` naming the hosts. The ASGARDEX port runs it |
| WalletConnect v2, WebSocket relay and HTTPS (S063) | P29 | ✅ built | `https.connect` for the relay host. The relay may check the `Origin` against a project allowlist, and the app's origin is what it sees |
| Hardware wallets over USB HID or WebHID (S064) and over WebUSB or Web Serial (S065) | device access | ⚠️ partial | WebHID works for an app that declares `devices.hid` and for a website, each device asked ([`capability-api.md`](../../architecture/capability-api.md), [Table 1a](table-1-capabilities.md)). WebUSB and Web Serial are not built, and the permission handler denies them. Not a network primitive |
| Hardware wallets over Bluetooth (S066) | device access | ❌ missing | No `select-bluetooth-device` listener exists, so Electron cancels every request ([Table 1b](table-1-capabilities.md)). Not a network primitive |
| Wallet bridges on loopback, Trezor Bridge 21325 and Ledger Speculos 9999 (S067) | P03, P25 | ✅ built | `localhost:<port>` declared. The bridge is a native process the person runs |
| Stratum mining pool, TCP 3333 and TLS 3334 (S068) | P01, P05 | ✅ built | `tcp.connect` or `https.connect` naming the pool, or `*:*` |

### Anonymity networks

| Protocol or stack | Primitives it needs | Status | What is missing, or the condition |
|---|---|:--:|---|
| Tor through a local daemon, SOCKS5 on 9050 or 9150 (S069) | P03, P34 | ⚠️ partial | The daemon is a native binary the person runs, because Orivon starts WebAssembly and JavaScript children only ([ADR-0040](../../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)). A hand-written SOCKS5 handshake over `net.connect('127.0.0.1', 9050)` should work with `localhost:9050` declared, and the destinations behind it need no manifest entry (not measured). `socks-proxy-agent` has no effect (P34), TLS through the tunnel needs P06 or P44, and a system proxy that points at Tor makes every `orivon.net` call refuse (P54) |
| Tor onion services as a client, `.onion` addresses (S070) | P03, P34 | ⚠️ partial | A `.onion` name means something only to the proxy, which the daemon row supplies. The broker never resolves it, and no pattern can authorise it as a name |
| Tor control port 9051 and `torrc` management (S178) | P03 | ⚠️ partial | `localhost:9051` declared; the plain-text control protocol should work over `net` (not measured). The daemon is native |
| Arti (Tor in Rust) as WebAssembly (S071) | P43, P01, P04 | ⚠️ partial | The program would need `wasi:sockets` TCP to arbitrary public relays (`tcp.connect: ["*:*"]`, which `orivon.net` provides), its own TLS, a current-thread runtime (the WASI host has no threads) and a clock and randomness (provided). Relay ports 9001 and 443 are not reserved. Whether Arti builds for `wasm32-wasip2` is not measured |
| Hosting an onion service (S072) | P43 | ⚠️ partial | Needs the Arti row or a running Tor. An onion service needs outbound circuits only, not an inbound port (not measured) |
| I2P through the SAM bridge, TCP 7656 (S073) | P03 | ⚠️ partial | `localhost:7656` declared. SAM streams are plain byte streams and should work (not measured). The router is a native process the person runs |
| I2P router as WebAssembly, NTCP2 over TCP and SSU2 over UDP (S074) | P12, P14, P15, P17, P43 | ❌ missing | Needs inbound TCP and UDP reachability (P13, P39) and IPv6 (P14) |
| Nym mixnet client, WebSocket to gateways (S075) | P29 | ✅ built | `https.connect` for the gateway hosts (not measured). The native SOCKS5 client is a daemon |
| Lokinet (S076), Yggdrasil and CJDNS (S077), and WireGuard, OpenVPN or any system-wide VPN (S079) | TUN device, routing-table access | ❌ missing | Each needs a TUN device and, for a VPN, routing-table access. No primitive offers either and no capability is proposed for them. Raw sockets and ICMP (P21) are excluded by design |
| WireGuard or OpenVPN as an in-app userspace tunnel (S078) | P15, P17, P43 | ⚠️ partial | Only the app's own traffic can enter the tunnel, through a userspace network stack inside a WebAssembly program. Needs `udp.send` naming the endpoint and a `udp.bind.network` range (not measured) |
| Mixnets and VPN-style apps in general (S080) | P01, P15, TUN device | ⚠️ partial | A SOCKS or HTTP proxy client works (Tor row). A proxy server can listen on loopback (P12). Anything that captures other programs' traffic needs a TUN device |

### Messaging and mail

| Protocol or stack | Primitives it needs | Status | What is missing, or the condition |
|---|---|:--:|---|
| IRC over TLS on 6697, with SASL (S081) | P05, P51 | ⚠️ partial | Port 6697 is reserved, so `*:*` does not reach it. `https.connect: ["*:6697"]` reaches any public server on that port, and the prompt names the port. Not yet run against a real IRC server |
| IRC plain TCP on 6667, with DCC chat and file transfer (S082) | P01, P51, P12, P13 | ⚠️ partial | Port 6667 is reserved as above. DCC needs a listener the peer can reach (`tcp.listen.network` and a forwarded port, P39) |
| XMPP with STARTTLS on 5222 (S083) | P06 | ❌ missing | The stream is plain until `<starttls/>`, then upgraded in place (P06) |
| XMPP direct TLS on 5223 (S084) | P05 | ✅ built | `https.connect` naming the server. Few servers offer it |
| XMPP SRV discovery, `_xmpp-client._tcp` (S085) | P24 | ❌ missing | `dns.resolveSrv` refuses by name. The client is told the host, or asks a DoH resolver |
| XMPP over WebSocket and BOSH (S086) | P29, P25 | ✅ built | `https.connect` naming the server |
| SMTP with implicit TLS on 465 (S087) | P05, P51 | ⚠️ partial | Port 465 is reserved, so `*:*` does not reach it. `https.connect: ["*:465"]` reaches any public server on that port, and a named `host:465` reaches that host. Not yet run against a real mail server |
| SMTP submission with STARTTLS on 587 (S088) | P06, P51 | ❌ missing | STARTTLS (P06), and port 587 is reserved (P51). The most common mail submission path |
| SMTP on port 25, direct-to-MX delivery (S089) | P51, P24, P06 | ❌ missing | Port 25 is reserved, `resolveMx` refuses by name (P24), and delivery uses STARTTLS (P06) |
| IMAP with implicit TLS on 993 (S090) | P05 | ✅ built | `https.connect: ["*:*"]` reaches any public server; 993 is not reserved |
| IMAP with STARTTLS on 143 (S091) | P06 | ❌ missing | STARTTLS (P06) |
| POP3 with implicit TLS on 995, or STLS on 110 (S092) | P05, P06 | ⚠️ partial | Port 995 works. STLS on 110 needs STARTTLS (P06) |
| JMAP over HTTPS (S093) | P25 | ✅ built | `https.connect` naming the server |
| Signal, HTTPS and WebSocket to Signal's own root certificate (S094) | P05, P08, P29 | ⚠️ partial | The transport works with `ca` set to Signal's root through Node `https` and `ws`. The routed `WebSocket` cannot set `ca` or headers (P29), and the cryptography package is a native addon ([Table 5](table-5-native-modules.md)) |
| Telegram MTProto, TCP to data-centre addresses or WebSocket (S095) | P01, P29 | ✅ built | `tcp.connect` for the data-centre addresses, or `wss:` under `https.connect` |
| WhatsApp multi-device, WebSocket with an `Origin` header and Noise (S096) | P29 | ⚠️ partial | The routed `WebSocket` sends the app's origin, not `https://web.whatsapp.com`, and the server may check it. The `ws` Node build over `upgrade` could set it (not measured) |
| Discord gateway, WebSocket with zlib-stream (S097) | P29 | ✅ built | `https.connect` for `gateway.discord.gg`. `permessage-deflate` is unavailable (P29), and the library falls back to `zlib-stream` |
| Discord voice, WebSocket plus UDP RTP to a run-time address (S098) | P15, P17, P16 | ⚠️ partial | `udp.send: ["*:*"]` and a `udp.bind.network` range (P16). IPv4 only, and the encryption package is a native addon ([Table 5](table-5-native-modules.md)) |
| Slack RTM and Socket Mode (S099) | P29, P25 | ✅ built | `https.connect` naming `slack.com` and the WebSocket host |
| Mattermost, HTTPS and WebSocket (S100) | P25, P29 | ✅ built | `https.connect` for the server. Token authentication works, and cookie session authentication fails because the routed path has no jar |
| Rocket.Chat, DDP over WebSocket (S101) | P29 | ✅ built | `https.connect` for the server |
| SIP over WebSocket with WebRTC media (S102) | P29, P32 | ✅ built | `https.connect` for the SIP WebSocket gateway. STUN and TURN are ungated |
| SIP over UDP and RTP (S103) | P15, P17, P16 | ⚠️ partial | `udp.send` to the server and `udp.bind.network` for the RTP ports. IPv4 only, NAT handling depends on the server, and a LAN PBX needs its literal (P02) |
| Jitsi, WebRTC plus XMPP over WebSocket (S104) | P29, P32 | ✅ built | `https.connect` for the meet host |
| Matrix VoIP (S105) | P32 | ✅ built | WebRTC is ungated, and the homeserver supplies the TURN servers |
| Mumble, TLS on 64738 with a client certificate and optional UDP voice (S106) | P05, P07, P08 | ✅ built | `https.connect` naming the server with `cert`, `key` and `rejectUnauthorized: false`. UDP voice is optional, and voice can ride the TCP tunnel |
| MQTT over TCP 1883 or TLS 8883 (S107) | P01, P05 | ⚠️ partial | A public broker works with `tcp.connect` or `https.connect`. The typical home broker is on the LAN and needs its literal (P02) |
| MQTT over WebSocket (S108) | P29 | ✅ built | `https.connect` for `wss:`, `tcp.connect` for `ws:` |
| AMQP 0-9-1 on 5672, with TLS on 5671 (S109) | P01, P05 | ✅ built | `tcp.connect` or `https.connect` naming the broker. A LAN broker needs its literal (P02) |
| NATS (S110) | P01, P05, P06, P29 | ⚠️ partial | The WebSocket client (`nats.ws`) works. The TCP client upgrades to TLS after `INFO` unless the server uses TLS-first, which is the `connectSecure` path (P06) |
| Kafka (S111) | P01, P05, P36 | ⚠️ partial | Direct TLS works. Brokers advertise their own hostnames, often private (P02), and many broker connections need a raised `concurrentSockets` (P36) |

### Databases and services an app dials

| Protocol or stack | Primitives it needs | Status | What is missing, or the condition |
|---|---|:--:|---|
| PostgreSQL, plaintext (S112) | P01 or P03 or P02 | ✅ built | `tcp.connect` naming the host, or `localhost:5432`. A LAN or private cloud host needs its literal (P02) |
| PostgreSQL with `sslmode=require` (S113), MySQL and MariaDB with TLS (S116), LDAP with StartTLS on 389 (S125), and explicit FTPS with `AUTH TLS` (S131) | P06 | ❌ missing | Each speaks plain first and upgrades the same socket, and `pg` calls `tls.connect({ socket })` (P06). PostgreSQL 17's direct TLS, with ALPN `postgresql`, would fit `connectSecure` if the client supports it |
| PostgreSQL (S114) and MySQL (S117) over a local Unix socket, Redis over a Unix socket (S121), and ssh-agent authentication (S128) | P22 | ❌ missing | Unix sockets (P22). PostgreSQL uses its socket by default for `localhost` |
| MySQL and MariaDB, plaintext (S115) | P01 | ✅ built | As PostgreSQL. `caching_sha2_password` over an unencrypted link needs the server's RSA key, handled in pure JavaScript |
| MongoDB, `mongodb://` with `tls=true` (S118) | P05 | ✅ built | `https.connect` naming every seed and replica member, because each host is dialled by name |
| MongoDB `mongodb+srv://`, SRV and TXT lookups (S119) | P24 | ❌ missing | `dns.resolveSrv` and `resolveTxt` refuse by name. A plain seed list works |
| Redis over TCP and TLS (S120) | P01, P05 | ✅ built | `tcp.connect` or `https.connect`. `ioredis`'s custom `dnsLookup` is ignored (P41) |
| Memcached (S122) | P01 | ✅ built | `tcp.connect` naming the host |
| Elasticsearch and OpenSearch over HTTPS (S123) | P25 | ⚠️ partial | Works where the client is built on `fetch` or `XMLHttpRequest`. The Node transport's `undici` and `http.Agent` pooling differ (P25, P38). `https.connect` naming the host |
| CouchDB and PouchDB replication over HTTPS (S124) | P25 | ⚠️ partial | Basic and JWT authentication work. Cookie authentication (`POST /_session`, then `Set-Cookie`) fails because the routed path has no cookie jar |
| LDAPS on 636 (S126) | P05 | ✅ built | `https.connect` naming the directory. A private directory needs its literal (P02) |
| SSH and SFTP, TCP 22 with the protocol's own cryptography (S127) and Git over SSH (S139) | P01, P02 | ⚠️ partial | TCP works and 22 is not reserved. The cipher set depends on the `crypto` polyfill ([Table 3e](table-3e-crypto-compression-buffers.md)), the host is usually private (P02), and a hop through another host works through the `sock` option |
| FTP control channel, passive mode (S129) | P01, P04 | ⚠️ partial | The server's `PASV` reply names an address and port chosen at run time. It is reachable under `*:*` only when public; a private answer is denied (P02) |
| FTP active mode, `PORT` (S130) | P12, P13 | ⚠️ partial | Needs a listener the server can reach (P12, P13, P39) |
| Implicit FTPS on 990 (S132) | P05 | ✅ built | `https.connect` naming the host. The data channel is a second implicit-TLS connection to a run-time port |
| SMB and CIFS, TCP 445 and 139 (S133) | P01, P51 | ⚠️ partial | Ports 445 and 139 are reserved, so `*:*` does not reach them. `tcp.connect: ["*:445"]` reaches any public server, and a named `host:445` reaches that host. The server is usually on the LAN, which needs its address written as a literal (P02) |
| NFS, TCP 2049 with the portmapper (S134) | P01, P15 | ⚠️ partial | RPC over TCP is plain. The portmapper lookup uses UDP 111, and LAN targets need literals (P02) |
| WebDAV, CalDAV and CardDAV (S135) | P25 | ✅ built | `https.connect` naming the server. `PROPFIND` and `REPORT` pass through the routed `fetch`, with no cookie jar |
| S3 and S3-compatible object stores (S136) | P25, P38 | ⚠️ partial | `https.connect` for the endpoint. SDK v3's Node handler relies on `Agent` pooling and streamed uploads, and the routed `fetch` buffers its request body (P38); the browser handler works |
| rsync daemon on 873 (S137) | P01 | ✅ built | `tcp.connect`. Over SSH it is the SSH row |
| Git over HTTPS (S138) | P25 | ✅ built | `isomorphic-git/http/web` over `fetch`, with `https.connect` for the forge |
| Docker Engine API over the Unix socket or a named pipe (S140) | P22 | ❌ missing | `docker-modem` issues `http.request({ socketPath })`, which is ignored and dials `localhost:80` (P22) |
| Docker Engine API over TCP, 2375 or 2376 with mutual TLS (S141) | P03, P05, P07 | ✅ built | `tcp.connect: ["localhost:2375"]`, or `https.connect` with `cert`, `key` and `ca` |
| Kubernetes API over HTTPS with client certificates or a bearer token (S142) | P05, P07, P08, P02 | ⚠️ partial | Agent TLS options are merged, so `cert`, `key` and `ca` work. Cloud clusters are public and work with a named host; on-premises API servers are private (P02) |
| Kubernetes exec, attach and port-forward, WebSocket with `Authorization` and `v4.channel.k8s.io` (S143) | P29 | ⚠️ partial | The routed `WebSocket` cannot set `Authorization` or trust a private CA (P29). The `ws` Node build over `upgrade` could (not measured) |
| gRPC over HTTP/2 (S144) | P26 | ❌ missing | `http2` has no HTTP/2 framing (P26) |
| gRPC-web (S145) | P25 | ✅ built | Needs a server or proxy that speaks gRPC-web or Connect. Response streaming works and request streaming is buffered |
| GraphQL subscriptions (S146) | P29, P31 | ✅ built | `https.connect` naming the API |
| Server-Sent Events APIs (S147) | P31 | ✅ built | The routed `EventSource`, or a streamed `fetch` for custom headers |
| DNS over HTTPS (S165) | P25 | ✅ built | `https.connect` naming the resolver (`cloudflare-dns.com:443`, `dns.google:443`) |
| DNS over TLS on 853 and DNS over TCP on 53 (S166) | P05, P01, P51 | ✅ built | DoT: `https.connect: ["1.1.1.1:853"]`. DNS over TCP: `tcp.connect: ["1.1.1.1:53"]`, the exact-named reserved port |
| ENS and DNSLink resolution (S167) | P25, P24 | ⚠️ partial | ENS by Ethereum JSON-RPC works. DNSLink needs a `TXT` query, which refuses by name (P24); DNS over HTTPS replaces it |
| SQLite over the network, a remote file or a libSQL server (S177) | P25 | ⚠️ partial | A SQLite file on a network filesystem is not a protocol and is not offered. libSQL's HTTP and WebSocket API works under `https.connect` |

### Home, media and device protocols

| Protocol or stack | Primitives it needs | Status | What is missing, or the condition |
|---|---|:--:|---|
| HomeKit HAP, accessory server and controller over TCP with mDNS advertisement (S148) | P12, P19 | ❌ missing | Advertising and finding need mDNS (P19). A controller given the address and port works over `net` to a declared literal (P02) |
| mDNS, DNS-SD and SSDP discovery, as in Bonjour and home automation (S149) | P19, P52 | ❌ missing | Multicast send and receive (P19, P52) |
| CoAP over UDP (S150) | P15, P17, P19 | ⚠️ partial | Unicast to a declared literal works with `udp.send` and `udp.bind.network`. Multicast discovery on `224.0.1.187` needs P19, and a LAN device needs its literal (P02) |
| Zigbee and Z-Wave through a serial coordinator (S151) | device access | 🚫 excluded by design | Web Serial is not built ([`capability-api.md`](../../architecture/capability-api.md)). A coordinator exposed over TCP (`tcp://host:6638`) works for a declared literal (P02). Not a network primitive |
| Matter (S152) | P19, P14 | ❌ missing | mDNS (P19) and IPv6 link-local UDP (P14) |
| Home Assistant, Node-RED and openHAB over WebSocket and REST (S153) | P29, P25, P02 | ⚠️ partial | Works for a public or tunnelled URL. A `homeassistant.local` name or a private address needs a declared literal (P02) |
| DLNA and UPnP AV media servers and renderers (S154) | P19, P28 | ❌ missing | SSDP needs multicast (P19). Serving media is an `http.createServer` under `tcp.listen.network` (P28) |
| Chromecast, mDNS discovery and CASTV2 over TLS on 8009 with a device certificate (S155) | P19, P05, P08 | ⚠️ partial | The TLS session to a declared literal works with `rejectUnauthorized: false`. Discovery needs multicast (P19). Casting local files needs an HTTP server on `tcp.listen.network` (P28) |
| AirPlay and RAOP, mDNS with RTSP and RTP over UDP (S156) | P19, P15 | ❌ missing | Multicast (P19) |
| Printers, IPP over HTTP 631 with mDNS discovery (S157) | P25, P19 | ⚠️ partial | Printing to a declared literal works. Discovery needs multicast (P19) |
| NTP, UDP 123 (S158) | P15, P16, P23 | ⚠️ partial | `udp.send` naming the pool plus a `udp.bind.network` range, the heavier prompt of P16 |
| SNMP, UDP 161 and 162 (S159) | P15, P18, P50 | ⚠️ partial | Unicast to declared literals with a bind grant works. Broadcast and discovery need P18 and P19, and trap listening on 162 needs a privileged port (P50) |
| syslog, UDP 514, TCP 514 or TLS 6514, and `/dev/log` (S160) | P15, P05, P22 | ⚠️ partial | UDP and TCP to a declared collector work, with the bind grant of P16 for UDP. `/dev/log` needs a Unix socket (P22) |
| Wake-on-LAN, UDP broadcast to port 9 (S161) | P18 | ❌ missing | A broadcast is denied or fails `EACCES` (P18). A unicast magic packet reaches a target that is in the ARP table (not measured) |
| LAN game discovery and matchmaking (S162) | P18, P19 | ❌ missing | Broadcast and multicast |
| RTSP, TCP 554 with RTP interleaved or over UDP (S163) | P01, P15 | ⚠️ partial | RTSP over TCP with interleaved RTP works. UDP RTP needs a bind range, cameras are on the LAN (P02), and `ffmpeg` is native |
| RTMP and RTMPS, 1935 and 443 (S164) | P01, P05, P12 | ⚠️ partial | The client side works. A media server listens on a declared port (P12) and can serve HTTP-FLV or HLS over `http.createServer` (P28), which no test runs (not measured) |

### Sign-in and web integration

| Protocol or stack | Primitives it needs | Status | What is missing, or the condition |
|---|---|:--:|---|
| OAuth 2 loopback redirect, `http://127.0.0.1:<port>` (S168) | P12, P28 | ⚠️ partial | The catcher is an `http.createServer` on `127.0.0.1` under `tcp.listen.local`, on a port inside a declared range (built; [Table 3d](table-3d-network.md)). The sign-in page cannot go to the system browser, because the external-link gate refuses `https:` ([Table 1b](table-1-capabilities.md)), so it must be shown in a popup or tab, and whether a tab may navigate to `http://127.0.0.1:<port>` is not measured. The provider must accept a redirect URI on that port |
| OAuth 2 in a popup, or a redirect that leaves and returns (S169) | window and navigation | ✅ built | Not a network primitive. A popup that keeps `window.opener` and a sign-in redirect that returns to the app are built ([Table 3i](table-3i-windows-and-lifecycle.md)) |
| OAuth device-code flow (S170) | P25 | ✅ built | `https.connect` naming the identity provider |
| OpenID Connect (S171) | P25 | ✅ built | As the two rows above. The Element port uses it |
| SAML (S172) | P25 | ⚠️ partial | Redirect binding works. A form `POST` back across the app boundary arrives as a `GET` (A233). An assertion consumer service is an HTTP server (P28), reachable at a loopback or LAN address only |
| Webhooks, inbound from the internet (S173) | P28, P11, P13 | ❌ missing | `http.createServer` exists (P28) but has no TLS (P11), and nothing opens a port to the internet (P13, P39). A relay that the app polls, or holds a WebSocket or SSE connection to, replaces it |
| Web Push, VAPID and the service worker `PushManager` (S174) | push service | ❌ missing | Receiving needs Chromium's push service, which Electron does not ship (not measured). Notifications themselves are built ([Table 3j](table-3j-permissions-devices-secrets.md)). Sending with `web-push` is HTTPS and works |
| FCM push receive, MCS over TLS 5228 to `mtalk.google.com` (S175) | P05 | ⚠️ partial | A direct TLS connection to a fixed host: `https.connect: ["mtalk.google.com:5228"]`. The protocol details are not measured |
| FCM HTTP v1 send and APNs (S176) | P25, P26 | ⚠️ partial | FCM v1 over HTTPS works. APNs is HTTP/2 (P26) |

## What one primitive would unblock

The rows are ordered by how many stacks each primitive blocks or limits. "Blocks" names the ❌ and 🚫 rows above that would start to run, and "limits" names the ⚠️ rows, and the ✅ rows whose note carries the condition, that would lose it. A private address is the commonest condition in the table: any stack that dials a host the person types in is limited the same way, and only rows where a private address is the ordinary case are named.

| Missing primitive | Stacks it blocks | Stacks it limits |
|---|---|---|
| Reach a private address without writing it in the manifest (P02): a subnet pattern or a "local network" scope with its own prompt | None outright: a declared literal is the route | BitTorrent peer wire (S001), libp2p TCP (S012), libp2p WebSockets (S014), Syncthing block exchange (S025), Electrum (S036), devp2p (S050), SIP over UDP (S103), MQTT (S107), AMQP (S109), Kafka (S111), PostgreSQL (S112), LDAPS (S126), SSH and Git over SSH (S127, S139), FTP passive (S129), SMB (S133), NFS (S134), Kubernetes API (S142), CoAP (S150), Home Assistant (S153), Chromecast (S155), printers (S157), RTSP (S163) |
| UDP multicast and broadcast (P18, P19, P52) | BitTorrent local peer discovery (S008), BitTorrent port mapping (S009), libp2p mDNS (S017), Syncthing local discovery (S026), HomeKit (S148), mDNS, DNS-SD and SSDP (S149), Matter (S152), DLNA (S154), AirPlay (S156), Wake-on-LAN (S161), LAN game discovery (S162) | Dat (S022), Secure Scuttlebutt (S023), GNUnet-style overlay (S024), CoAP (S150), Chromecast (S155), printers (S157), SNMP (S159) |
| Upgrade an open socket to TLS (P06); a user-space TLS stack over a plain grant (P44) does the same today at the cost of shipping a TLS library | XMPP with STARTTLS (S083), SMTP on 587 (S088), SMTP on 25 (S089), IMAP on 143 (S091), PostgreSQL `sslmode=require` (S113), MySQL with TLS (S116), LDAP StartTLS (S125), explicit FTPS (S131) | POP3 (S092), NATS (S110), TLS through a Tor tunnel (S069), Monero over Tor (S054) |
| Reach a port behind a NAT (P39, P13) | Matrix homeserver and ActivityPub server (S030, S032), webhooks (S173), BitTorrent port mapping (S009), I2P router (S074) | BitTorrent peer wire (S001), Lightning BOLT (S040), IRC DCC (S082), FTP active mode (S130) |
| Unix domain sockets and named pipes (P22) | Core Lightning `lightning-rpc` (S044), PostgreSQL, MySQL and Redis sockets and ssh-agent (S114, S117, S121, S128), Docker Engine API socket (S140) | syslog (S160) |
| DNS record queries (P24) | XMPP SRV (S085), MongoDB `mongodb+srv` (S119), direct-to-MX SMTP (S089) | IPFS `dnsaddr` and DNSLink (S019), Bitcoin DNS seeds (S035), ENS and DNSLink (S167) |
| HTTP/2 client (P26) | LND gRPC, Core Lightning gRPC and Zcash lightwalletd gRPC (S041, S045, S056), gRPC over HTTP/2 (S144) | APNs (S176) |
| UDP send-only socket with no inbound grant (P16); a `udp.bind.local` socket cannot send to a public address | None | BitTorrent UDP trackers (S003), Discord voice (S098), SIP over UDP (S103), NTP (S158), syslog (S160) |
| A TUN device (not a network primitive; no primitive offers it) | Lokinet (S076), Yggdrasil and CJDNS (S077), system-wide VPN (S079) | WireGuard in user space (S078), VPN-style apps (S080) |
| TLS server (P11) | Matrix homeserver and ActivityPub server (S030, S032), webhooks (S173) | Syncthing block exchange (S025) |
| Custom headers and TLS options on the page's `WebSocket` (P29) | None | LND REST WebSocket (S043), Signal (S094), WhatsApp (S096), Kubernetes exec (S143) |
| IPv6 listen and UDP bind (P14) | I2P router (S074), Matter (S152) | BitTorrent peer wire (S001), devp2p (S050) |
| A native daemon the app starts (Tor, I2P router): Orivon starts WebAssembly and JavaScript children only ([ADR-0040](../../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)) | None | Tor daemon (S069), onion services (S070), I2P SAM (S073), Tor control port (S178) |
| USB, HID, serial and Bluetooth devices (WebHID built; USB and serial excluded; not a network primitive) | Hardware wallets over HID, WebUSB and Web Serial (S064, S065), over Bluetooth (S066), Zigbee and Z-Wave serial coordinators (S151) | None |
