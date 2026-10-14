# `src/protocols/nym-tunnel/`: the host that runs Nym's mixnet client as WebAssembly, and offers it as a SOCKS5 server

**What lives here.** The utility process that carries an installed app's traffic through the Nym mixnet when the
person routed the app and left the tunnel on its default ([`ADR-0083`](../../../docs/decisions/ADR-0083-nym-is-the-built-in-tunnel-and-runs-in-a-utility-process-of-its-own.md)).
The process offers SOCKS5 (CONNECT and UDP ASSOCIATE) on a loopback port, behind a secret, so the tunnel for apps
([`../../main/route/`](../../main/route/)) reaches it exactly as it reaches a SOCKS5 server the person runs. The module
is Nym's `smolmix` client with raw TCP and UDP added (`vendor/nym-smolmix/`), published on IPFS and pinned by hash in
`resources/nym-tunnel/nym-tunnel.json`.

| File | Holds |
|---|---|
| [`entry.ts`](entry.ts) | The process: takes `start{ config }` on its parent port, hands it to `service.ts`, and posts what happens |
| [`service.ts`](service.ts) | The work apart from the process: the globals the module needs, the module loaded from its pinned files, the tunnels per user name, and the SOCKS5 server in front of them |
| [`socks-server.ts`](socks-server.ts) | SOCKS5 on `127.0.0.1:<port>`: username/password only, the password being the secret (compared in constant time); CONNECT by name or address; UDP ASSOCIATE with the relay on loopback, for the port the client declares; no BIND, no other method |
| [`instances.ts`](instances.ts) | One tunnel per SOCKS5 user name; starts at the first request, which waits for it; closes after ten minutes unused (a name made for one short use, the Settings test, after five seconds); replaces a tunnel whose streams stall; at most `maxInstances` alive, and past that a new app is refused, never given another app's tunnel |
| [`module-loader.ts`](module-loader.ts) | Reads the glue and the `.wasm` once and hashes them against the pins, compiles the `.wasm` once, and brings a tunnel up in a fresh instance of the glue, trying again under a new identity when a gateway fails; hands the module addresses, never names |
| [`dns.ts`](dns.ts) | The lookups of one tunnel: A, then AAAA, queries sent as datagrams through the tunnel to a public resolver, any number at once, each retried, with a cache that follows the answers' lifetimes |
| [`module-net.ts`](module-net.ts) | The module's only network: `fetch` and `WebSocket` over a dispatcher that dials `https:` and `wss:` alone, and only addresses that are public unicast |
| [`protocol.ts`](protocol.ts) | What main and this process say to each other: plain data |

**Tied to Electron.** Disposable. [`entry.ts`](entry.ts) uses `process.parentPort`, which only a utility process has; every
other file takes what it needs as arguments and runs under plain vitest. The main process's side is
[`../../main/route/`](../../main/route/) (`nym-launch.ts` is the one file that imports `electron`).

**What it depends on.** [`../local-node/pinned-file.ts`](../local-node/pinned-file.ts) (reads a pinned file and hashes it),
[`../../broker/policy/address.ts`](../../broker/policy/address.ts) (the address classifier), the `socks` package (its UDP frame
format), `undici` (the dispatcher) and `fake-indexeddb` (the module's IndexedDB, in memory).

**What it must never import.** `electron`, and [`src/main/`](../../main/) beyond types. Nothing here reaches a window, a session or a
profile.

**Owner stream.** `broker`.

## Design notes

**The server is written here because no maintained one does UDP ASSOCIATE.** Rule 6 asks for a mature component first. The
pure-JavaScript SOCKS5 servers on npm (`socksv5`, `socks5-server`, `@pondwader/socks5-server`, and `simple-socks`, the
one still maintained) take CONNECT with a password, and none carries UDP ASSOCIATE. The tunnel for apps carries UDP, and a routed app that cannot send a datagram would break the contract of the route.
The server here is about 300 lines over `node:net` and `node:dgram`, and uses the `socks` package (already the route's
client) for the UDP frame format, so both ends read one implementation of it. Every rule is proved against that
client in [`tests/socks-server.test.ts`](tests/socks-server.test.ts).

**The relay accepts datagrams from the port the client declared.** The route's client binds its datagram socket first and
declares that port in its UDP ASSOCIATE request; the relay passes on datagrams from `127.0.0.1` at that port and nowhere else,
answers that port alone, and refuses a request that declares port 0, so a program on this computer that reaches the relay's
ephemeral port cannot take the association by sending first. The association ends with its control connection.

**A client that has not signed in is held small.** Such connections have a place of their own (32; past it the oldest of them makes room), apart from the 512 of
clients that have signed in and asked for something, and what one sends is read a few kilobytes at a time: the rest waits in the
kernel, not in this process. A client that closes before it asks for anything gives its place back at once.

**A stream that never opens is refused after 45 seconds.** The module has a 30-second limit of its own for a TCP connect;
a connect measured once did not return within 90 seconds, so the server does not rely on it. A stream that opens after
the refusal is closed.

**A client's end is not passed on at once.** The module cannot half-close: closing the write side of a Nym stream ends its
reading too (measured against a plain HTTP server: the request was sent, the stream closed, and nothing came back). So the
server accepts half-open connections (`allowHalfOpen`) and, when a client has sent all it will send, keeps reading the
answer; the stream is closed once the far end ends, or after ten quiet seconds. A client that closed for good and one
waiting for its answer look the same, which is why a connection is released ten seconds after its client went.

**Each tunnel is a fresh instance of the module.** The glue keeps its state in the module instance and allows one tunnel
per instance; after `disconnectMixTunnel` the same instance refuses a new one (measured). So each tunnel imports the glue
again from a `data:` URL made of the bytes that were hashed, with a comment of its own at the end so it is another module,
and instantiates the one compiled `.wasm`. The instances stay in this process until it exits, so the process reports how many tunnels it has started and main
replaces it, as soon as no tunnel is open, after 24 (`RECYCLE_AFTER_STARTS`), and in any case ten minutes after the last
tunnel closes.

**Names are looked up here, not by the module.** The module resolves a name inside `connectTcp` under one lock that it holds for
the whole query, so every new name waits behind the one before it (each takes about a second through the mixnet, so a page with six
new hosts spent six seconds on lookups alone) and a datagram lost on the way stalls them all for the module's 30 seconds. In the runs measured about one tunnel
in six came up answering no datagram at all, and under the lock every connection it was asked for then failed after 45 seconds, again
and again, with nothing ever replacing it. [`dns.ts`](dns.ts) asks for itself: queries to `8.8.8.8` (the module's own first choice) that go on to `1.1.1.1` after three quiet
seconds and again after six, all at once, over the tunnel's own datagram socket, so the resolver sees the exit and nothing is looked up on this
computer. The module is then given an address, which it does not look up. The address a name had before is not remembered beyond the answer's
lifetime (30 seconds to five minutes), and a name that the resolver says does not exist is a refusal of that name, not of the tunnel.

**A tunnel that carries nothing is closed, and the next request gets another.** A stream that does not open (no resolver answered
in twelve seconds, or no connection within 45) is a *stall*; a refusal by the destination is not. A tunnel that has opened nothing yet is closed at its second stall in a
row, one that has opened a stream at its third, and any stream that opens clears the count. A stall says nothing of the destination (a name that does not exist, a host that is down) but of the tunnel only when it
repeats with nothing opening in between, which is why the count is of consecutive stalls and not of how many a page asks for.
A tunnel that cannot come up (a gateway that closes the connection, or none that answers in 30 seconds) is tried again, up to three times, under a new
identity, which is what makes the module pick another gateway.

**The Settings test's tunnel does not outlive its answer.** Each tunnel sends cover traffic and builds Sphinx packets for as long as it
is open, which costs about a third of a core (below), so the user name made for the test (`orivon-test-` and a word) is closed five seconds after its connection ends, not ten minutes.

**What a tunnel costs the processor, and the module's options.** Measured with the pinned module under plain Node on an eight-core
computer, a tunnel with nothing going through it uses about 32% of one core (a single thread: the cover and Poisson-timed packets are
built in WebAssembly, and nearly all of that time is curve25519 in `smolmix_wasm`), in an Electron utility process the same. It
is the module's own traffic, not a loop here: `read()`, `recv()` and the server wait on promises and timers. `setupMixTunnel` takes `disableCoverTraffic` and
`disablePoissonTraffic`; with the first the same idle tunnel uses 1.7%, with the second 3.2%, with both 0.1%, and a 300 KB download took 16, 10 and 11 seconds
(one run each; the mixnet's own variation is as large). Each is a choice about what a network observer can learn from when packets are sent, so neither is changed here: this build
leaves both on. *Provisional*: the owner decides; the figures are the input.

**The module's network is a dispatcher, not a wrapper.** A check made on a name before the module dials it would let a
name that answers differently the second time lead to a private address. `module-net.ts` puts the check where the dial
takes its addresses: a `lookup` that answers only when every address of the name is public unicast (one other refuses the
whole name), and a connector that refuses any scheme but `https:` (which a redirect or a `ws:` would otherwise reach) and
any literal address that is not public. The same dispatcher serves `fetch` and `WebSocket`, which are replaced on
`globalThis` before the glue is imported. Rules, each proved in [`tests/module-net.test.ts`](tests/module-net.test.ts): loopback, LAN,
link-local, carrier-grade NAT, multicast, reserved, unspecified and IPv4-mapped forms are refused.

**The module's IndexedDB is in memory.** `fake-indexeddb` supplies it, so nothing the module keeps (its keys, its gateway
registration) outlives the process, and a new tunnel starts from nothing: its identity and its gateway are new.

**What Nym sees.** Nym's gateways see this computer's address, because the process connects to them directly; the
destinations see only the exit. A system proxy configured in the shell: the process does not start, because its
connections to the gateways would go around the proxy (`docs/architecture/security-model.md`, T20 and T85). That check
is main's, in [`../../main/route/nym-subsystem.ts`](../../main/route/nym-subsystem.ts).

**The secret is per start.** Main makes a port and a secret at each start, and every connection must send the secret as the
password. A page cannot reach the port (main refuses every request from a tab, app or frame to a port a local node or
this host holds), and a program on this computer cannot use the tunnel without the secret.

**Memory.** Measured in a real Electron 44 utility process: 107 MB resident with nothing loaded, 132 MB with the module
compiled and the server up, 176 MB with one tunnel, 182 MB with two, 222 MB with six and 257 MB with seven. The first
tunnel costs about 45 MB (the compiled module's first instance) and each further one 6 to 15 MB. The cap is six.

**Test seam.** `LoaderSeams` lets a test import a glue its own way. A test build can run a stand-in module in place of the
pinned one (`ORIVON_TEST_NYM_MODULE`, [`../../main/route/nym-test-seam.ts`](../../main/route/nym-test-seam.ts)), which an
ordinary build does not carry. `ORIVON_NYM_TUNNEL_DIR` names a directory of the real module's files (still hash-checked),
and `ORIVON_NYM_TUNNEL_LOG=1` leaves the module's own log lines in the process's output.
