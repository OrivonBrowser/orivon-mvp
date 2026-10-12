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
content is still checked. Two, because the node resolves their names through this computer's resolver, and a
resolver that hijacks DNS breaks the first with a certificate error. `light-dht` asks the network only and names
no service. An option that is missing or unknown means `light-dht`, the mode that tells no service anything. A change of the setting stops the node, and its next
start has the new argument.

**Ready means the health endpoint answers.** The node reports `listening` and `ready` together when
`GET /health` first answers (as soon as its listener is up; lookups happen on first use): it holds no peer set
to count, so there is nothing to wait for beyond that.

**What it opens.** Outbound TCP only (peers, the lookup services, DNS-over-HTTPS), one TCP listener on its
loopback address, no UDP in practice (WASI has no QUIC), and in its data directory only `blocks.db` with its
`-wal` and `-shm` files (SQLite, its cache capped at 256 MB inside the node). The rules in
[`../local-node/node-net.ts`](../local-node/node-net.ts) suffice as they are.

**Residual.** The API is a loopback HTTP server, which a page in any tab can request. It serves reads only,
and a page that can name a CID can already ask any public gateway for it; what the node adds is that such a
request makes this computer fetch that content from the network.

**Test seams.** `ORIVON_IPFS_NODE_LIVE=1` runs the real node
([`test/web3/e2e-ipfs-node-live.test.ts`](../../../test/web3/e2e-ipfs-node-live.test.ts), never in CI).
