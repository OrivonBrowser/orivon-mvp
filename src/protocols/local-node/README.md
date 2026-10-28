# `src/protocols/local-node/`: the host that runs a node on this computer, as WebAssembly

**What lives here.** The utility process that runs a node (a Rust program built for `wasm32-wasip2`,
transpiled by jco) and everything it is handed, for every kind of node. A node serves an HTTP API on a
loopback port; the protocol that uses it reads from that endpoint and verifies what it reads, so nothing
here is trusted for content. [`entry.ts`](entry.ts) is the one process entry and [`kinds.ts`](kinds.ts)
finds the kind a start message names; [`service.ts`](service.ts) is the work, [`component.ts`](component.ts)
loads jco's output from a directory (it reads each file through [`pinned-file.ts`](pinned-file.ts), which the Nym tunnel host uses too), [`node-net.ts`](node-net.ts) and [`node-fs.ts`](node-fs.ts) are the only
network and files the component reaches ([`node-dns.ts`](node-dns.ts) is how `node-net.ts` finds a name's addresses; [`node-route.ts`](node-route.ts) and [`route-source.ts`](route-source.ts) are the network of a node that runs through a tunnel), and [`protocol.ts`](protocol.ts) is what main and this process say to
each other. The main process's side (starting on demand, the pinned-file check, the idle stop, the backoff and
the refusal memory) is [`../../main/verifier/local-node-controller.ts`](../../main/verifier/local-node-controller.ts)
and its neighbours.

**What a kind supplies.** A `NodeKind` ([`kind.ts`](kind.ts)) and nothing else. A kind lives in its own folder
(`../swarm-node/`) and is one line in `kinds.ts`:

```ts
interface NodeIdentity {
  readonly name: string // the resources folder and the manifest's name (resources/<name>/<name>.json), and the key kinds.ts finds it by
  readonly noun: string // how a sentence names it after "the": 'Swarm node'
}

interface NodeKind extends NodeIdentity {
  arguments: (config: LocalNodeConfig) => string[] // argv of the component, the program name first
  prepare: (dataDir: string, apiPort: number) => Promise<void> // the config files it reads from its data directory, for this run's port
  watchReadiness: (deps: ReadinessDeps) => Readiness // posts `listening` and `ready`; sees every log line
}
```

The kinds are `swarm-node` ([`../swarm-node/`](../swarm-node/)) and `ipfs-node` ([`../ipfs-node/`](../ipfs-node/)). What
the person chose that a kind turns into arguments (the IPFS node's routing mode) travels in the start config's
`options`, plain strings that main reads at each start, so a changed choice reaches the next start.

The environment variables `ORIVON_<NAME>_DIR` (a directory of files to run, still hash-checked) and
`ORIVON_<NAME>_LOG` (`1` prints the node's log) follow from the name (`envName` in [`protocol.ts`](protocol.ts)).

**A page never reaches a node's port.** Main cancels every request from any tab, app or frame, in any session, to a
loopback port a local node holds, whichever spelling of loopback it uses ([`../../main/sessions/local-node-port-gate.ts`](../../main/sessions/local-node-port-gate.ts)).
The verifier host reads a node from a utility process, which is no session.

**Tied to Electron.** Disposable. [`entry.ts`](entry.ts) uses `process.parentPort`, which only a utility
process has; every other file takes what it needs as arguments and runs under plain vitest. The main
process's side is [`../../main/verifier/`](../../main/verifier/) (`local-node-launch.ts` is the one file that
imports `electron`).

**What it depends on.** [`../../shim/wasi-p2/`](../../shim/wasi-p2/) (the WASI 0.2 host, which is
durable), [`../../broker/adapters/`](../../broker/adapters/) (the Node socket adapters, which make no
decision), [`../../broker/route/`](../../broker/route/) (the SOCKS5 provider a routed node dials through) and [`../../broker/policy/address.ts`](../../broker/policy/address.ts) (the address
classifier) and [`../gateways/`](../gateways/) (the DNS-over-HTTPS query and the allowlisted fetch, which the verifier host uses too). `node-net.ts` is where the decisions are made. `kinds.ts` imports each kind's `kind.ts`, and is
the only file here that names a kind.

**What it must never import.** `electron`, and [`src/main/`](../../main/) beyond types. A component is not
app code, but nothing here may reach for a window, a session or a profile. Nothing but `kinds.ts` imports a
kind's folder, so a kind's code cannot leak into the shared host.

**Owner stream.** `ens-ipfs`.

## Design notes

**A node that cannot be set up says why at once.** `startNode` ([`service.ts`](service.ts)) posts `failed` for any throw before the component
runs: the data directory, the files and network handed to the component, the load. Main then marks the node failed, a Swarm page names the
reason, and IPFS reads from its gateways without waiting for a node that will never answer. Guest paths in the WASI host are POSIX on every
platform (`../../shim/README.md`), whatever the host process's own `path` is.

**A node holds no grant, so the seam is the whole defence.** An app's sockets pass the broker's
grants; a component's pass `node-net.ts` alone. A hostile peer, or a hostile DNS answer, can ask the
node to connect anywhere it can name. The rules, each proved by a test in `tests/node-net.test.ts`:

| Call | Allowed | Everything else |
|---|---|---|
| `connect` | A public unicast address, or a name whose answers are all public: the name is resolved once (over DNS-over-HTTPS first, `node-dns.ts`) and the checked literals are dialled. A name with one non-public answer is refused whole. A host that is neither a literal nor a plain DNS name (a scoped IPv6 address) is refused. Ports 1 to 65535 | `denied`, with nothing dialled: loopback, LAN, link-local, carrier-grade NAT, multicast, reserved, unspecified, IPv4-mapped forms of these |
| `listen` | Loopback only, on the API port or on a port the system picks | `denied`. A `network` listen is refused so the WASI host asks again as `local`: the node's peer-to-peer listen ends up on loopback, which a light node does not need more than |
| `udpBind` | An ephemeral port, loopback or every interface (a reply from a public resolver cannot reach a socket bound to loopback) | A fixed port is `denied` |
| datagram send | A public unicast address, port 53 (the Swarm node asks a public resolver for its bootnodes' `/dnsaddr` records; the IPFS node resolves its peers' names over TCP instead), sent as the canonical address that was checked | Dropped and counted, as a refused send is for an app |
| datagram received | One whose source is a public unicast address on port 53 | Dropped and counted in `droppedInbound` |
| limits | 300 sockets the node opens (TCP and UDP), 128 connections accepted on its listeners (counted apart, so Orivon's reads of the API never take a peer's place), 4 listeners, 64 answers per lookup, 64 files | `limit`; a connection accepted past its limit is closed at once |

**A name is resolved over DNS-over-HTTPS first.** A resolver that hijacks DNS answers a name with its own server, a
public address `node-net.ts` allows, and the node's TLS to it then fails its certificate check, so a service only
that name reaches never loads. `node-dns.ts` asks the DNS-over-HTTPS endpoints main puts in the config
(`dohEndpoints`, the list the verifier host uses) for the A and AAAA records, and uses the system resolver only
when every endpoint failed to answer at all (unreachable, malformed, timed out), so a network that blocks DoH still
works. Then DoH is not asked again for a minute, but only when the endpoints failed (unreachable, timed out, a non-2xx status, a malformed body); a name they answer with SERVFAIL, REFUSED or another failing status goes to the system resolver for that name alone, uncached, and DoH stays in use for the next one. A name DoH says has no address (NXDOMAIN, or both families answered empty) stays unresolved and is remembered for 30 s; a failure is never remembered, and when one family could not be asked and the other named nothing, that counts as a failure and the system resolver answers. `node-net.ts` checks
the answers exactly as it checks the system resolver's, so a non-public answer from either refuses the whole name, and
no rule was widened. The process's fetch reaches only the configured endpoints and follows no redirect
([`../gateways/allowlisted-fetch.ts`](../gateways/allowlisted-fetch.ts)). Answers are kept for their TTL, between 10 s
and 5 min, for at most 256 names; an answer from one family alone is used once and not kept. The DoH provider learns the names the node resolves (lookup services, peers'
hostnames, HTTP providers), never the sites a person visits.

A system proxy configured in the shell: a node does not start, because its sockets would go around the proxy
(`docs/architecture/security-model.md`, T20). That check is main's, in
[`../../main/verifier/local-node-controller.ts`](../../main/verifier/local-node-controller.ts).

**With the whole browser on the tunnel, a node runs through it, or does not run.** The start config carries
`routed: true` and the process builds its network from [`node-route.ts`](node-route.ts) instead of the direct adapters; the
rules in the table above (which address, which port, how many) are still `node-net.ts`'s and do not change. Every `connect`
is a SOCKS5 CONNECT to the checked literal address through the tunnel (IPv4 first, the next address tried when one fails,
at most thirty-two openings in flight so a mixnet tunnel is not handed hundreds together). Every datagram goes through UDP
ASSOCIATE: the only datagram socket in the process is the SOCKS5 client's own, bound on loopback for a tunnel on this computer, and the node can send nothing through it that the tunnel's relay does not carry. A name is looked up by DNS-over-HTTPS over a TLS connection
the tunnel carries (a CONNECT to the endpoint's name, its certificate checked for that name; the connection is kept for the
next query), and there is no system resolver to fall back to: a name the endpoints cannot answer stays unresolved. The API
listener stays on loopback, as for a direct node. A routed node whose process has no way to ask for a route gets no network.
[`route-source.ts`](route-source.ts) is how the process learns where the tunnel is: it posts `route-ask` on its parent port and main answers with
the tunnel's port, the secret the tunnel's host made for its start and the node's own user name (never an argument or a log line); the answer is kept until main says
`route-reset` (the tunnel's process restarted on another port) or the proxy refuses a connection outright, and a refusal from
main (the tunnel cannot run) is not kept. The sign-in is a user name of the node's own, so Nym gives the node a mixnet client
and an exit of its own (ADR-0086). With the person's own SOCKS5 address as the tunnel the same path works, minus what that
address lacks: Tor's SOCKS5 has no UDP ASSOCIATE, so a routed node there has no datagrams and the Swarm node cannot resolve `/dnsaddr` bootnode names
by UDP; everything else (streams, names by DNS-over-HTTPS, the IPFS node's resolver, which speaks TCP) goes through it.

A website that has its tunnel on by itself, with the browser-wide setting off, reads IPFS through the gateways over its tunnel and
never through a node: the node is one process for the whole browser, so it cannot be direct for the pages that are not tunnelled
and tunnelled for this one (*provisional*; a node per tunnel identity would settle it).

**The files are confined by the real path.** `node-fs.ts` rejects `..` as a path segment (a name such as `..cache` is an ordinary name), absolute paths, NUL, and the names Windows reserves for devices (`CON`, `NUL`, `COM1`, `LPT1` and the rest, any extension, any case) on every system, so the policy is the same everywhere; then
resolves the real path of the file or of its deepest existing ancestor and requires it to stay inside
the real directory, so a symlink cannot lead out. A dangling symlink is refused too, since opening it
for writing would create what it points at. A check followed by an open leaves a window for a link
swapped in between; nothing the component can do makes a link, and a local process able to is
already inside the profile.

**The component runs where JSPI is on.** jco's output suspends through `WebAssembly.Suspending`, which
Electron 44's utility processes have without a flag. No other route is needed. The core modules
compile in tens of milliseconds, because V8 compiles their functions lazily, and the process settles
near 270 MB.

**A taken API port ends in a new port.** The port is chosen quietly when the host starts. If the node cannot
bind it, the process says so (`failed`, stage `port`), main chooses another for the next start, and whoever
fixed the old endpoint in place (the verifier host holds it from its start) is put to sleep and rebuilds it from
the new port when its next request wakes it. That is the smaller change: telling a running host its endpoint
would mean a gatherer whose pool of endpoints can change. A start that cannot succeed (a proxy, files that are not the
pinned ones, a compile failure, a taken port) is not retried on the backoff; it waits for the next ask, and a
refusal is answered from memory for ten seconds, so a page reading chunks does not hash the files again for each
read. A crash restarts on the backoff.

**The process runs only bytes it hashed itself.** Main checks the files against the pinned hashes first, as an
early refusal, and hands the pins to the process in its config. The process reads each file once
(`readPinned`), hashes those bytes, and uses those same bytes: the glue is imported from a `data:` URL made of
them (a file in a directory with no `package.json` would make Node guess its module type and warn on
stderr), and each core module is compiled from them. A name that is not pinned is refused, so a file changed
after main's check, or a core module the glue names that was never pinned, never runs.

**Test seams.** `LoaderSeams` lets a test run a fixture component in a process with no JSPI by
default, as `src/shim/wasi-p2/tests/support/` does; a kind is a plain object, so a test supplies its
own (`tests/service.test.ts` runs a second kind that is nothing like the Swarm node).
