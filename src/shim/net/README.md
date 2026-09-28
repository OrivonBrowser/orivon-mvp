# `src/shim/net/`: `net`, `tls`, `dgram` and `dns` over `orivon.net`

**What lives here.** Everything built on `orivon.net`. `net.ts` (`net.Socket`, `connect`/
`createConnection`, `net.Server`/`createServer`, `isIP`), `socket.ts` and `server.ts`, `args.ts`
and `isip.ts` (shared argument parsing). `tls.ts` (`tls.connect`/`TLSSocket` over
`orivon.net.connectSecure`), `tls-options.ts` (translating Node's option shapes) and
`tls-identity.ts` (Node's own `checkServerIdentity`, ported line for line). `dgram.ts` and
`dgram-socket.ts` (`createSocket` over `orivon.net.udpBind`). `dns.ts` and `dns-promises.ts`
(`lookup`/`promises.lookup` over `orivon.net.lookup`).

**What it depends on.** [`../../contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
[`../node-errors.ts`](../node-errors.ts), [`../unimplemented.ts`](../unimplemented.ts) and
[`../stream-bytes.ts`](../stream-bytes.ts). `http/` depends on this folder (a real `net.Socket`
underlies every request); this folder never depends on `http/`.

**What it must never import.** `electron`, or [`../../broker/`](../../broker/) -- see the parent
README's "What it must never import".

**Owner stream.** `shim`, build step 3.

## Design notes

**Why `net.Socket`/`dgram.Socket` instances are NOT wrapped the same way as a module
namespace.** A throw-on-*read* proxy is exactly wrong for a stateful, duck-typed instance real
Node libraries feature-detect before calling (`if (typeof socket.setBroadcast === 'function')
...`, `'unref' in socket`): it would make that defensive check itself throw, turning a graceful,
intentional skip into a crash. That would be a *regression*, not an improvement, **and it is
exactly the regression A169 found `refusingProxy` itself shipped with at the module-namespace
grain** (`net.ts`/`../net/dns.ts` etc.), months after this paragraph named the failure mode;
A169's fix (see the parent README's Design notes) makes `refusingProxy` itself safe to read,
closing that gap at its source. `class` prototypes remain non-writable/non-configurable
regardless (`Socket.prototype = proxy` throws), so wrapping is still not mechanically available
at the prototype level the way it is for a plain exported object. That structural reason, not the
now-fixed throw-on-read behaviour, is why instances stay on their own mechanism. `socket.ts` and
`dgram-socket.ts` add the handful of real Node members a porting app is likely to hit as actual
present methods: the same "present, throws when called" shape `../fs/unsupported.ts`'s
`syncUnsupported`, `../http/unsupported.ts`'s `createServer`, and `refusingProxy` itself all use
for their own decided gaps. `ref`/`unref` are safe NO-OPS rather than throws: real Node's
contract for them is "no meaning, returns `this`", and there is no event-loop handle to ref/unref
here. The dgram socket options (`setBroadcast`, the multicast family) throw when called: a silent
no-op there would misreport a real capability as applied instead of naming the gap, which is the
exact failure A135 exists to fix.

**[`tls.ts`](tls.ts) honours Node's TLS options by passing them to `orivon.net.connectSecure`.**
The broker does the handshake under the app's own `ca`, `rejectUnauthorized`,
`cert`/`key`/`pfx`/`passphrase`, `servername` and `ALPNProtocols`, and reports `authorized`,
`authorizationError`, the negotiated ALPN protocol and the peer certificate, which the
`TLSSocket` exposes as Node does (`getPeerCertificate()` returns the certificate with `raw` and
`pubkey` as Buffers; no issuer chain, which the broker does not report). [`tls-options.ts`](tls-options.ts)
translates Node's option shapes (Buffers, one-element arrays, `{ pem, passphrase }` objects,
wire-format ALPN) and refuses by name what nothing could apply: a prebuilt `secureContext`, a
credential array with more than one entry, and STARTTLS. A custom `checkServerIdentity` runs
here, against the reported certificate, in Node's order: the broker is asked not to refuse on its
own default check, a chain error still decides alone, and the app's function replaces the default
hostname check. A failing verdict closes the handle before the dial promise settles, so a write
queued before `'secureConnect'` never reaches an unverified peer. [`tls-identity.ts`](tls-identity.ts)
is Node's own `tls.checkServerIdentity`, ported line for line and tested against Node's as the
oracle, because most custom checks call it first. `../http/https.ts` merges an agent's options
over the request's, as Node does, and sends the Host header's name as SNI when the caller set no
`servername`.

**STARTTLS (`tls.connect({ socket })`, `new tls.TLSSocket(socket)`) refuses by name.** `pg`, SMTP
and IMAP clients upgrade a plain connection in place, and the broker has no operation for that: a
`connectSecure` connection is TLS from its first byte. What it would take is recorded in
[`../../../docs/open-questions.md`](../../../docs/open-questions.md) A226.

**[`server.ts`](server.ts) refuses a loopback-only `listen()` host rather than widening it.**
**AI recommendation, not owner-reviewed.** `orivon.net.listen` binds every interface and has no
host parameter. A listener an app binds to `127.0.0.1`, `::1` or `localhost` is usually an
unauthenticated local control surface (an RPC port, an OAuth redirect catcher); binding it on
every interface instead would expose it to the network, which neither the app's code nor
anything the user was shown asked for. Refusing by name is loud and names the fix (omit the
host); accepting with a warning would be quiet exactly where a mistake is a security one. A host
meaning "every interface" (`0.0.0.0`, `::`) is accepted, since that is what happens anyway.
Accepted sockets close when the server closes, unlike Node: they are derived handles the broker
closes with the server handle (`../../../docs/architecture/handle-contracts.md`'s "TcpServer"
section).

**[`dns.ts`](dns.ts) answers an IP literal and `localhost` itself.** Node's `lookup` never asks a
resolver about a literal, and routing one through `orivon.net.lookup` would let a grant deny a
lookup that reaches nothing. `localhost` answers `127.0.0.1` (or `::1` when family 6 is asked
for) for the same reason: resolving it leaves the machine for no one.

**[`dgram-socket.ts`](dgram-socket.ts) validates a send the way Node does, before the broker
sees it.** A bad port or a non-string address throws synchronously, as in Node; a payload past
65507 bytes calls back with `EMSGSIZE` (or emits `'error'` when there is no callback); a hostname
is resolved through `dns.lookup` first, as Node's own `send` does. The broker's write path would
otherwise drop a malformed datagram silently.
