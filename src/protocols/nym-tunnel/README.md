# `src/protocols/nym-tunnel/`: the host that runs Nym's mixnet client as WebAssembly, and offers it as a SOCKS5 server

**What lives here.** The utility process that carries an installed app's traffic through the Nym mixnet when the
person routed the app and left the tunnel on its default ([`ADR-0082`](../../../docs/decisions/ADR-0082-nym-is-the-built-in-tunnel-and-runs-in-a-utility-process-of-its-own.md)).
The process offers SOCKS5 (CONNECT and UDP ASSOCIATE) on a loopback port, behind a secret, so the tunnel for apps
([`../../main/route/`](../../main/route/)) reaches it exactly as it reaches a SOCKS5 server the person runs. The module
is Nym's `smolmix` client with raw TCP and UDP added (`vendor/nym-smolmix/`), published on IPFS and pinned by hash in
`resources/nym-tunnel/nym-tunnel.json`.

| File | Holds |
|---|---|
| [`entry.ts`](entry.ts) | The process: takes `start{ config }` on its parent port, hands it to `service.ts`, and posts what happens |
| [`service.ts`](service.ts) | The work apart from the process: the globals the module needs, the module loaded from its pinned files, the tunnels per user name, and the SOCKS5 server in front of them |
| [`socks-server.ts`](socks-server.ts) | SOCKS5 on `127.0.0.1:<port>`: username/password only, the password being the secret (compared in constant time); CONNECT by name or address; UDP ASSOCIATE with the relay on loopback; no BIND, no other method |
| [`instances.ts`](instances.ts) | One tunnel per SOCKS5 user name; starts at the first request, which waits for it; closes after ten minutes unused; at most `maxInstances` alive, and past that a new app is refused, never given another app's tunnel |
| [`module-loader.ts`](module-loader.ts) | Reads the glue and the `.wasm` once and hashes them against the pins, compiles the `.wasm` once, and brings a tunnel up in a fresh instance of the glue |
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

**The relay accepts datagrams from one client.** The first datagram fixes the client's port on loopback; a datagram from any
other port, or from any address but loopback, is dropped. The association ends with its control connection.

**A stream that never opens is refused after 45 seconds.** The module has a 30-second limit of its own for a TCP connect;
a connect measured once did not return within 90 seconds, so the server does not rely on it. A stream that opens after
the refusal is closed.

**Half-open connections stay open.** A client that has sent all it will send still receives the answer
(`allowHalfOpen`), as it would from a server it reached directly.

**Each tunnel is a fresh instance of the module.** The glue keeps its state in the module instance and allows one tunnel
per instance; after `disconnectMixTunnel` the same instance refuses a new one (measured). So each tunnel imports the glue
again from a `data:` URL made of the bytes that were hashed, with a comment of its own at the end so it is another module,
and instantiates the one compiled `.wasm`. The instances stay in this process until it exits, which is why main stops the
process ten minutes after the last tunnel closes.

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
