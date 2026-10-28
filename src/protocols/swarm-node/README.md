# `src/protocols/swarm-node/`: Orivon's own Swarm light node

**What lives here.** What makes the shared local-node host ([`../local-node/`](../local-node/)) a Swarm
light node (Rust, `wasm32-wasip2`, transpiled by jco): [`kind.ts`](kind.ts) is its `NodeKind`,
[`config.ts`](config.ts) writes its YAML and arguments, [`readiness.ts`](readiness.ts) counts its peers,
and [`protocol.ts`](protocol.ts) is the Swarm node's name and the notices main and the verifier host
exchange about it. The node serves Bee's HTTP API on a loopback port; the Swarm protocol reads chunks from
that endpoint and verifies every one of them, so nothing here is trusted for content. Everything that does
not depend on Swarm (the process, the confined network and files, the pinned-file check, the start,
the idle stop and the backoff) is shared: see the local-node README.

**Durable.** Every file here takes what it needs as arguments and runs under plain vitest; the process it runs
in ([`../local-node/`](../local-node/)) is the part tied to Electron. The main process's side is
[`../../main/verifier/`](../../main/verifier/) (`swarm-node-subsystem.ts`).

**What it depends on.** [`../local-node/`](../local-node/) (the kind interface and the protocol types).

**What it must never import.** `electron`, and [`src/main/`](../../main/) beyond types.

**Owner stream.** `ens-ipfs`.

## Design notes

**Residual.** The API is a loopback HTTP server, but main cancels every request from any page, in any
session, to its port ([`../../main/sessions/local-node-port-gate.ts`](../../main/sessions/local-node-port-gate.ts)),
so no page can time it. A DNS name an attacker points at 127.0.0.1 is not caught by that URL filter. It
serves reads only (no upload endpoint works without a postage batch, and the node has none). A reply from a
resolver's address is not matched to a query by the host; the node checks its own transaction ids.

**Ready means eight peers.** The node reports `listening` once its API answers and `ready` once `/peers`
(or `/topology`, or the `peer_set_size` its log prints when the API has no count) shows `READY_PEERS`
connected peers.

**It keeps 250 peers.** A Bee peer serves a light node a few chunks a second on credit, so the number of peers
bounds how fast a file arrives, and `config.ts` asks for 250 where the node keeps 100 by itself. A start from a
saved peer list reaches them in about two seconds; the mount that starts meanwhile waits a second or two longer for
its first chunks, which the faster file more than repays. A first start finds its bootnodes over UDP DNS, which
the WASI host serves on IPv4 only, so the node's resolver is refused its IPv6 servers at once
([`../../shim/wasi-p2/README.md`](../../shim/wasi-p2/README.md)) and its first peer arrives about eight seconds
after the start.

**Test seams.** `ORIVON_SWARM_NODE_LIVE=1` runs the real node
([`test/web3/e2e-swarm-node-live.test.ts`](../../../test/web3/e2e-swarm-node-live.test.ts), never in CI).
