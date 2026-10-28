# `src/protocols/ipfs-node/`: Orivon's own IPFS node

**What lives here.** What makes the shared local-node host ([`../local-node/`](../local-node/)) an IPFS
node (Rust, `wasm32-wasip2`, transpiled by jco): [`kind.ts`](kind.ts) is its `NodeKind`,
[`config.ts`](config.ts) builds its arguments, [`readiness.ts`](readiness.ts) polls its `/health`, and
[`protocol.ts`](protocol.ts) is its name, the routing choice and the state main and the verifier host exchange
about it. The node serves the trustless gateway API (`/ipfs/<cid>?format=raw`, `/ipns/<key>?format=ipns-record`)
on a loopback port; the IPFS protocol ([`../ipfs/`](../ipfs/)) reads blocks and IPNS records from that
endpoint and checks every one of them itself, so nothing here is trusted for content, only for availability,
as a public gateway is. Everything that does not depend on IPFS (the process, the confined network and files,
the pinned-file check, the start, the idle stop and the backoff) is shared: see the local-node README.

**Durable.** Every file here takes what it needs as arguments and runs under plain vitest; the process it runs
in ([`../local-node/`](../local-node/)) is the part tied to Electron. The main process's side is
[`../../main/verifier/`](../../main/verifier/) (`ipfs-node-subsystem.ts`).

**What it depends on.** [`../local-node/`](../local-node/) (the kind interface and the protocol types).

**What it must never import.** `electron`, and [`src/main/`](../../main/) beyond types.

**Owner stream.** `ens-ipfs`.

## Design notes

**It only reads.** The node serves what it has found and keeps the blocks it fetched in one SQLite database
in its data directory. It does not serve other peers, provide content to the network, or pin: it opens
connections out and listens only on loopback ([`../local-node/node-net.ts`](../local-node/node-net.ts)).

**The person's choice is an argument.** `web3.ipfsLookupService` decides the routing mode, which main hands
the kind in the config's `options` (`routingOptions`). `auto` asks two delegated lookup services
(`DELEGATED_ROUTERS` in [`config.ts`](config.ts), one comma list the node races and fails over across) and the
IPFS network at the same time and uses the first answer, so the services learn which content is looked up; the
content is still checked. Two, so that one failing does not stop the other; the node resolves their names over
DNS-over-HTTPS first, so a resolver that hijacks DNS does not steer it at a server that is not theirs. `light-dht` asks the network only and names
no service. An option that is missing or unknown means `light-dht`, the mode that tells no service anything. A change of the setting stops the node, and its next
start has the new argument.

**Two ways to resolve a name.** An HTTP client in the node (a lookup service, DNS-over-HTTPS, an HTTP provider) resolves its
host through the host's name lookup, which asks DNS-over-HTTPS first (`../local-node/node-dns.ts`). The node's peer-to-peer
layers resolve the `/dns4`, `/dns6` and `/dnsaddr` names of peers themselves, over TCP to port 53 of `1.1.1.1` and `1.0.0.1`
(Cloudflare's resolvers, never this computer's own), so the host sees them as TCP connections to two public addresses and
the node needs no datagram. They are plain DNS, asked of Cloudflare whatever the Secure DNS setting says. With the whole browser on a tunnel and nodes following it, those connections go through the
tunnel like the node's other streams.

**A provider behind a relay.** A provider whose only address is `<relay address>/p2p/<relay id>/p2p-circuit/p2p/<peer>`
can be fetched from: the node ranks it after every provider with a direct address, and reaches it through a circuit relay
v2. The relay is whichever one the provider's record names, so the node's dial to it goes through the same `connect` rule
as any peer's ([`../local-node/node-net.ts`](../local-node/node-net.ts)): a public address, by TCP, through the tunnel when
the node follows it. The node only dials through a relay. It holds no reservation on one and is not reachable through
one, so it still listens on loopback alone. The relay sees this computer's address and the provider's, and how much is
sent, but not the content: the node and the provider encrypt the connection end to end, and every block is checked
against its CID in any case. A transfer through a relay is as fast as the relay lets it be. When the node asks a peer it
fetched from a moment ago for the next block, it waits 2 seconds for the answer, and 8 when every address of that peer
is a relay address: a provider whose idle connection has closed needs about 2.5 seconds to be reached again.

**How a provider is found.** The network side of a lookup (`light-dht`, and `auto` beside its services) walks the public
DHT on a swarm built for that one lookup and dropped after it. It asks 10 peers at a time and holds at most 64
connections and 32 dials in progress; a dial gets 5 seconds and a connection closes 5 seconds after its last request,
because most peers a walk meets never answer, and a walk that kept the ones that did would reach its own limits before
the peers nearest the key. A provider behind a relay is in no peer's routing table, so the only address of it is the one in
the record a peer returned for it: the walk keeps that address, which is what lets the node reach the provider through its
relay. The walk ends 250 milliseconds after the first provider it has an address for. These numbers are the node's own
defaults; its `ORIVON_IPFS_DHT_*` variables replace them for a measurement and Orivon sets none of them.

**Ready means the health endpoint answers.** The node reports `listening` and `ready` together when
`GET /health` first answers (as soon as its listener is up; lookups happen on first use): it holds no peer set
to count, so there is nothing to wait for beyond that.

**What it opens.** Outbound TCP only (peers, a relay a provider's record names, the lookup services, HTTP providers, DNS-over-HTTPS, and the two resolvers above),
one TCP listener on its loopback address, no UDP in this build (WASI has no QUIC, and its own resolver speaks TCP), and in its
data directory only `blocks.db` with its
`-wal` and `-shm` files (SQLite, its cache capped at 256 MB inside the node). Its own bounds on connections: at most 64
connections and 32 dials in progress for each lookup's walk, up to 16 connections to the providers it fetches from and 8
HTTP provider reads at once. Every lookup walks on a swarm of its own, so the 300 sockets that `MAX_SOCKETS` allows the node
are what bounds all of them together. The rules in [`../local-node/node-net.ts`](../local-node/node-net.ts) suffice as they are. SQLite also locks the database with a directory
`blocks.db.lock` beside it, and a node killed in the middle of a write leaves that directory, after which every start fails with
"database is locked"; `prepareDataDir` takes it away at each start, which is safe because the supervisor starts the next
process only after the last has exited.

**The store is keyed by partition.** The verifier sends `x-orivon-partition` (`PARTITION_HEADER`) on every read:
`base64url(sha256(salt || partition))`, 43 characters, with a per-profile random salt that only the verifier host
holds. The node keeps its blocks, hot cache and in-flight fetches by (partition, CID), so its database holds no
origin in plain text, and one site's reads are never another's hits. A read with no header is served from the
network and kept nowhere. Clearing cached data or all history stops the node, deletes `blocks.db`, its journal,
`-wal` and `-shm`, and replaces the salt.

**Residual.** The API is a loopback HTTP server, but main cancels every request from any page to its port
([`../../main/sessions/local-node-port-gate.ts`](../../main/sessions/local-node-port-gate.ts)), so no page can time
it. What stays shared is the node's short-lived provider and peer caches and its in-flight lookups, across sites,
for minutes, as a gateway's edge cache is.

**Test seams.** `ORIVON_IPFS_NODE_LIVE=1` runs the real node
([`test/web3/e2e-ipfs-node-live.test.ts`](../../../test/web3/e2e-ipfs-node-live.test.ts), never in CI).
