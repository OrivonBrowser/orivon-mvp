# `src/shim/net/`: `net`, `tls`, `dgram` and `dns` over `orivon.net`

**What lives here.** Everything built on `orivon.net`: `net.Socket`/`net.Server`, `tls`
(`TLSSocket` over `connectSecure`), `dgram` over `udpBind`, and `dns.lookup` over `lookup`.

**What it depends on.** [`../../contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
[`../node-errors.ts`](../node-errors.ts), [`../unimplemented.ts`](../unimplemented.ts) and
[`../stream-bytes.ts`](../stream-bytes.ts). `http/` depends on this folder; this folder never
depends on `http/`.

**What it must never import.** `electron`, or [`../../broker/`](../../broker/): see the parent
README's "What it must never import".

**Owner stream.** `shim`, build step 3.

## Design notes

**Socket instances are not wrapped with `refusingProxy`.** A class prototype cannot be replaced by
a proxy, so `socket.ts` and `dgram-socket.ts` give the Node members a porting app is likely to hit
as real methods, present so feature detection (`typeof socket.setBroadcast === 'function'`) still
works. `ref`/`unref` are no-ops returning `this`, as Node's contract allows. The dgram socket
options throw when called: a silent no-op would report an option as applied that was not.

**[`tls.ts`](tls.ts) passes Node's TLS options to `orivon.net.connectSecure`** (`d-0099`); the
broker does the handshake and the verification it is asked for. A custom `checkServerIdentity`
runs here, in Node's order, and a failing verdict closes the handle before the dial settles, so a
queued write never reaches an unverified peer (`tls-options.ts`). STARTTLS and a prebuilt
`secureContext` refuse by name: the broker has no in-place upgrade (A226).

**[`server.ts`](server.ts) and [`dgram-socket.ts`](dgram-socket.ts) map a bind address onto a
scope, and refuse an address that is neither loopback nor "every interface"**
([`../bind-scope.ts`](../bind-scope.ts), `ADR-0034`). `127.0.0.1`, `::1` and `localhost` ask for
`'local'`; no host, `0.0.0.0` and `::` ask for `'network'`, which is Node's own default. An app
holding only the local grant that binds with no host is not refused: the `'network'` ask is
refused as `'denied'`, is asked again as `'local'`, and `address()` reports the loopback address
it actually got. An app holding the network grant is served on every interface as before. A
refusal of any other host names the fix; a warning would be quiet exactly where the mistake is a
security one, and the broker binds loopback or every interface, never one other address. Accepted
sockets close with the server, unlike Node: the broker closes derived handles with the server
handle ([`handle-contracts.md`](../../../docs/architecture/handle-contracts.md) §TcpServer).

**[`dgram-socket.ts`](dgram-socket.ts) validates a send before the broker sees it**, as Node does:
the broker's write path drops a malformed datagram silently.
