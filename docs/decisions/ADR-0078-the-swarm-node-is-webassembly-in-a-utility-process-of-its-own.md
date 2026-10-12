# ADR-0078: Orivon's own Swarm light node runs as WebAssembly in a utility process of its own

- **Status:** accepted (the process shape); the wiring into the Swarm protocol follows in the same pull request.
- **Date:** 2026-10-12
- **Type:** architecture / security
- **Decided by:** owner (no public gateways: `d-0603`; the node as WebAssembly in a utility process of its own: `d-0604`); AI recommendation accepted by default for the process shape

## Decision

Swarm content is read from a Swarm light node that Orivon runs on the person's own computer, never from a
public gateway. The node is a Rust program compiled to `wasm32-wasip2` and transpiled by jco. It runs in an
Electron utility process of its own (`src/protocols/swarm-node/`), against the WASI 0.2 host
(`src/shim/wasi-p2/`), with a network and a directory handed to it by two small files that make every
decision: `node-net.ts` and `node-fs.ts`. Main starts it when a Swarm mount needs it, stops it when the
verifier host sleeps or after ten minutes with no mount, and does not start it when a system proxy is
configured. The files that make it up are pinned by size and sha256 in `resources/swarm-node/swarm-node.json`,
compiled into the app, and checked before every start.

## Context

[`ADR-0040`](ADR-0040-native-shaped-node-features-run-as-webassembly.md) runs an app's WebAssembly in the
app's own tab and rejected a utility-process WASI host for app code, because the app's bytes would then run
beside the browser with the authority of Node. The Swarm protocol verifies every chunk it reads from any
Bee-style endpoint, so it needs one endpoint it can trust to be there and not to be a third party's server;
the owner decided that endpoint is a node on the person's own machine.

## Alternatives considered

- **Run the node in the verifier host.** Rejected: that process holds every untrusted parser and serves every
  protocol's pages; a trap or a leak in a peer-to-peer node should end only the node.
- **Run the component in a Worker of a hidden page over `orivon.*`, as an app would.** Rejected: it needs a
  grant for every peer a node may dial, and there is no person to grant them; the grant model is for apps a
  person chose, not for a part of the browser.
- **A native binary of the node.** Rejected: Rule 8 and `ADR-0040`; one download per operating system, and no
  confinement beyond what Orivon adds around a process it cannot look into.
- **Public gateways as the fallback.** Rejected by the owner (`d-0603`).

## Reasoning

The reason `ADR-0040` gave does not apply: this is not app code. The component is WebAssembly, which reaches
only the imports the seam hands it, so a hostile peer or a hostile DNS answer can ask the node for nothing but
what `node-net.ts` allows (public unicast only, loopback listens, DNS-port datagrams, 300 sockets) and
`node-fs.ts` allows (one directory, confined by real path). Its JavaScript glue is generated at our build and
pinned by hash with the module, so what runs is what was published. A utility process has JSPI without a
flag, so jco's output runs as it is.

## Consequences

- A fourth bundle entry (`swarm-node-host`) and a resources folder that `package:*` must fetch (`--required`).
- A Swarm address needs about 15 seconds on a cold profile for the node to find its peers, and the node holds
  about 270 MB while it runs.
- The node's HTTP API is on a loopback port a page in any tab can request; it serves reads only.
- The WASI host's `poll` had to stop leaving a reaction per call on a quiet socket's promise
  (`src/shim/wasi-p2/README.md`), which any busy program would have hit.

## Reversibility

- **Cost to reverse:** moderate. The seam and the process are one folder and one bundle entry; the Swarm
  protocol reads an endpoint and does not know what serves it.
- **What would make us revisit:** a Swarm node that cannot find peers from inside the seam's rules, or a
  component that needs a capability the seam refuses and no rule can safely give.
