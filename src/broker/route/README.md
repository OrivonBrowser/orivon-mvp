# `src/broker/route/`: the network route an app can have

**What lives here.** What the broker needs from a network route and nothing about how one is
carried. [`provider.ts`](provider.ts) is `RouteProvider`: open a TCP stream to `host:port` (the
name unresolved), and optionally carry UDP and resolve names. [`socks5.ts`](socks5.ts) is the
provider for a SOCKS5 proxy, over the `socks` package. [`socks5-probe.ts`](socks5-probe.ts) asks a proxy for its greeting and opens nothing through it (the
Settings page's Test). [`table.ts`](table.ts) turns the proxy a
person set for an app into `routeFor(key)`. [`routed-socket.ts`](routed-socket.ts) and
[`routed-secure.ts`](routed-secure.ts) open a plain and a TLS stream through a route in the shape
the broker hands an app.

**What a route does to `orivon.net`.** For an app that has one, `connect`, `connectSecure`,
`lookup` and `udp.send` go through the route and nothing else: no name is resolved on this
machine, nothing is dialled directly, and T20 is not asked, because the route is the app's proxy.
What the route cannot carry is refused (`denied`), never sent direct. A failure inside the route
is `unreachable`. `listen` and `udp.bind` are allowed with scope `local` and `denied` with scope
`network`: a route gives no address others can reach. The grant checks are the ones an unrouted
app has, with one difference: a hostname is matched by name
([`../policy/connect-routed.ts`](../policy/connect-routed.ts)), because the address it points to is
the proxy's to choose, so what a name that points into the local network reaches is the proxy's
decision. The paths are in
[`../capabilities/`](../capabilities/); the broker option is `CreateBrokerOptions.routeFor`.

**What it depends on.** [`../broker-contracts.ts`](../broker-contracts.ts) (types),
[`../errors.ts`](../errors.ts), [`../io-errors.ts`](../io-errors.ts),
[`../adapters/`](../adapters/) for the stream wrappers and the TLS handshake, `node:net`,
`node:tls`, `node:dgram`, `node:crypto` and the `socks` package.

**What it must never import.** `electron`, [`../capabilities/`](../capabilities/),
[`../grants/`](../grants/), [`../handles/`](../handles/) or [`../transport/`](../transport/): the
route is consulted by those, and holds no grant, handle or window. Where a person's proxy is stored
and how a front for Chromium is run are not this directory's business.

**Tied to Electron?** No: **durable**. A different engine keeps it; main supplies the store that
`routeFor` reads.

**Owner stream.** `broker`.

## Design notes

**[`socks5.ts`](socks5.ts)'s greeting offers "no authentication" and username/password
together.** `socks` offers username/password only when credentials are given, and always offers
no authentication, so a proxy that takes none still works and one that isolates streams by
credentials (Tor by default) gets a distinct pair per app. `isolationCredentials` derives the pair:
the user name is a hash of the origin key, the password an HMAC of it under a secret made for the
run.

**[`socks5.ts`](socks5.ts) takes back the bytes the proxy sends right after its reply.** A target
that speaks first (a mail or IRC server) can have its first bytes arrive in the same segment as
the reply. `socks` buffers them and re-emits them in a later turn, which loses them when nothing
listens yet, so the provider holds them and pushes them back in front of the stream.

**[`socks5.ts`](socks5.ts) accepts a UDP datagram only from the relay the proxy named.** The local
socket is bound for the relay's sake alone and connected to the relay's address and port, so the
kernel itself drops a datagram from anything else.
The broker side does the same for an app's socket: inbound datagrams are accepted from the route
and from this machine, and from nothing else
([`../capabilities/net-udp-route.ts`](../capabilities/net-udp-route.ts)).

**`RouteProvider.connect` returns a `Socket`, not a bare duplex.** The broker's stream wrappers,
its close table and the TLS layer are written against one, and a provider that has only a duplex
can wrap it.

**A routed socket reports the destination the app named as its remote address, and no local
address.** What the app sees is the route's far end; the proxy's address would only show where it
listens.
