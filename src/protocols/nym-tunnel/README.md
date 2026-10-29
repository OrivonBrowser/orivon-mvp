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
the whole query, so every new name waits behind the one before it (about a second each through the mixnet) and a datagram lost on the way stalls them all for the module's 30
seconds; a tunnel that answers no datagram at all would fail every connection for good. [`dns.ts`](dns.ts) asks for itself: queries to `8.8.8.8` (the module's own first choice) that go on to `1.1.1.1` after three quiet
seconds and to `8.8.8.8` again after six, any number at once, over the tunnel's own datagram socket, so the resolver sees the exit and nothing is looked up on this
computer. The module is then given an address. Answers are kept for their lifetime (30 seconds to five minutes). A name the resolver says does not exist, or that both resolvers fail for, is a refusal of that name; only a name that
no resolver answered for within twelve seconds counts against the tunnel. The cache is shared by everything that uses a tunnel, which with the whole browser on the tunnel is every site: a page can time whether another asked for a name lately (*provisional*; the host does not see the site).

**A tunnel that carries nothing is closed, and the next request gets another.** A lookup that no resolver answered, a datagram socket that cannot be bound, or a stream that does not open in 45 seconds is a *stall*; a refusal by the destination (the module's own connect timeout included, which a destination can cause by itself) is not. A tunnel that has opened nothing yet is closed at its second stall in a
row, one that has opened a stream at its third, and any stream that opens clears the count; a stall of an opening that began before another stream opened is not counted, and a user name's tunnel is replaced at most once a minute, because a page chooses what it asks for and so what stalls.
A tunnel that cannot come up (a gateway that closes the connection, or none that answers in 30 seconds) is tried again, up to three times, under a new
identity, which is what makes the module pick another gateway; a request waits for all three (95 seconds).

**The Settings test's tunnel does not outlive its answer.** Each tunnel sends cover traffic and builds Sphinx packets for as long as it
is open, which costs processor time (below), so the user name made for the test (`orivon-test-` and a word) is closed five seconds after its connection ends, not ten minutes.

**What a tunnel costs the processor, and the two privacy levels.** Measured with the pinned module on an eight-core computer, a tunnel with nothing going through it uses 26 to 37% of one core by default (a single thread: the cover and Poisson-timed packets are
built in WebAssembly, nearly all of it curve25519 in `smolmix_wasm`), in an Electron utility process the same. It
is the module's own traffic, not a loop here: `read()`, `recv()` and the server wait on promises and timers. `setupMixTunnel` takes `disableCoverTraffic` and
`disablePoissonTraffic`; with the first an idle tunnel used 0.8 to 26%, with the second 1.2 to 3.2% in a first run, with both 0.1%. A 300 KB download through a tunnel took 9 to 16 s by default, 10 to 13 s without cover traffic, 13 to 16 s without the Poisson stream and 11 to 17 s with neither (two to three runs each; the mixnet's own variation is as large as the differences).
Each is a choice about what a network observer can learn from when packets are sent: Nym sends packets at a steady randomised rate (about 50 a second), with decoys filling any gap, so an observer of the connection cannot tell when the person is active, and loop cover packets (about five a second) besides.
The host offers two levels ([`protocol.ts`](protocol.ts)'s `mixOptionsFor`), set by `network.nym.privacy` and made known to the host in its config and by a `privacy` message:
**Balanced**, the default, passes `disablePoissonTraffic`: the steady stream is off and loop cover traffic stays, so real activity shows as bursts to someone watching the connection, though the mixnodes still delay and mix the packets. **Strongest** passes Nym's own defaults. Idle, measured again with the level in place (60 s each, after a stream had been opened and closed): Strongest 34 to 38% of a core, Balanced 8 to 9% in the host alone, 4 to 6% for a tunnel nothing has been opened through, and 7 to 15% in the whole browser with every site on the tunnel. Throughput did not differ.
A level applies to the tunnels started after it: `instances.ts`'s `renewAll` closes a tunnel nobody is using at once and one in use when its last stream or association ends, so the next request starts one at the new level. A request from an app whose old-level tunnel is in use joins that tunnel, so a busy app keeps the old level until it has a moment with nothing open; cutting its streams to hurry that along was left out.

**How fast a tunnel carries a download, and what does not limit it.** Measured through real tunnels on one eight-core computer with plain HTTP range requests (several tunnels, three downloads each, two to four rounds): one connection carries 30 to 45 KB/s whatever the server, two connections about 50, four about 90 to 130, and the total stops growing near 120 KB/s, where the module's single thread is at 100% of a core. A round trip through the mixnet is 0.5 to 1 s, so a new connection costs one to two (TCP), two to three more with TLS, and a first request to a host about 2.5 s. Three things were tried and do not move the rate of one connection: a larger TCP window (256 KB and 1 MB receive and send buffers with window scaling, so a window no longer bounds a connection to 64 KB per round trip), more reply SURBs per packet (4 and 8; 8 was slower and used more processor time), and more SURBs at the connection's start (50). What the measurements did find, and the module now fixes (`vendor/nym-smolmix/UPSTREAM.md`, patches 2 and 3), is a send queue that dropped packets and reply frames that reach TCP out of order. What holds one connection near 40 KB/s on a server that sends cleanly is not known (*provisional*; a capture at the exit would settle it).
- the send loop dropped every packet past the eighth it found queued in a 5 ms tick, so a burst of connections waited for TCP's retransmit timer (4 s): 16 connections opened at once connected in 0.9 s (eight of them) and 5 s (the other eight), 32 in waves of 4 s over 20 s; now 16 take under 1 s and 32 about 2.5 s (the processor is then at 95%), and through this host 32 parallel requests finished in 2.3 s (median 1.9 s) where they took 15 s (median 10 s);
- the exit's reply frames arrived out of order, four in ten after a frame numbered higher, and the sender's TCP took that for loss. The module now hands TCP the frames in order (a wait of 1.5 s at most for a missing one). A 700 KB file from a Google server took 85 to 143 s (5 to 8 KB/s) before and 15 to 25 s (28 to 48 KB/s) after; a plain HTTP file about 25% faster; the processor 20 to 25% instead of 30%.
A tunnel is sometimes dead from the start: one in ten or twelve connected to nothing for 30 s, its first reply never arriving, with the pinned module as well.

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
and `ORIVON_NYM_TUNNEL_LOG=1` leaves the module's own log lines in the process's output and in the browser's log, which otherwise
holds only the lines that begin `[nym-tunnel]` ([`../../main/diagnostics/README.md`](../../main/diagnostics/README.md)).
