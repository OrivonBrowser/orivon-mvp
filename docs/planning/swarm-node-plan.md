# Swarm's local node: plan

**Need.** The owner decided that Swarm content is loaded only from a node Orivon runs on the
user's own machine, never from public gateways. Until the node runs, Swarm stays off. The
Swarm protocol (`src/protocols/swarm/`, its PR is separate) already verifies every chunk from any
Bee-API endpoint; this step gives it its one endpoint: a Swarm light node, written in Rust and
compiled to `wasm32-wasip2`, that Orivon runs as WebAssembly in a utility process of its own.

**Confidentiality.** No tracked file, commit, branch or PR names the node's upstream project,
its authors or its organisation, and none links to them. Call it "the Swarm node" or "a Swarm light
node". The built component is named `swarm-node` (jco `--name swarm-node`). Its license file
(Apache-2.0, which names nobody) travels with it.

## What exists

- **The component.** It is built in a private build repository (its build script transpiles it with jco). Measured under wasmtime: `/health` in 1 s, 100 peers in 13 s, a chunk in
  about 0.2 s, single-owner chunks served, a missing chunk answers 404 in 3.3 s, 57 MB resident.
  Its HTTP API is Bee's shape: `GET /chunks/<hex>` returns `span ‖ payload`. Config is Bee's
  YAML: `api-addr`, `mainnet: true`, `full-node: false`, `swap-enable: false`,
  `storage-incentives-enable: false`, `skip-postage-snapshot: true`, `data-dir`, `password`.
  Flags: `--config=<path> --no-control-socket --no-disk-cache`. It needs outbound TCP to public
  peers, UDP DNS (it asks a public resolver on port 53 for the bootnodes' `/dnsaddr` TXT records),
  one loopback TCP listen for its API, and a data directory. It runs single-threaded.
- **The WASI 0.2 host**, `src/shim/wasi-p2/`. It is parameterised by `SocketNet` (`connect`, `listen`,
  `udpBind`, `lookup` of `OrivonNet`) and `WasiFs` (`open`, `stat`, `readdir`, `mkdir`, `rm`,
  `rename` of `OrivonFs`), and entered with `instantiateComponent` (`run.ts`). Apps run it in a
  Worker over `orivon.*`.
- **Node socket adapters with no policy**, `src/broker/adapters/`: `dialTcp`, `listenTcp`,
  `bindUdp`, `resolveLookup`, and `socket-streams.ts`, which works around a Node stream bug.
  **Pure policy**, `src/broker/policy/`: `isPublicUnicast` and `canonicalAddress` in
  `address.ts`.
- **A supervised utility process to copy.** The verifier host: `HostSupervisor` (restart backoff,
  `idle()`, `stop()`), `HostLifecycle` (idle after 10 min), `loopback-port.ts`, `listening-gate.ts`,
  and a rollup entry in `electron.vite.config.ts`.
- **A download-and-verify script to copy**: `scripts/fetch-bundled-extensions.mjs`. It pins a
  sha256 per file, renames into place only after the hash matches, does not fail `postinstall`,
  and runs with `--required` in `package:*`.

## Design

### Step 0: probe JSPI in a utility process, before building anything

jco's output needs `WebAssembly.Suspending` and `WebAssembly.promising`, and nothing in this
repository runs them in a `utilityProcess`. Through `node scripts/run-headless.mjs`, fork a probe
utility process that reports `typeof WebAssembly.Suspending`. If it is missing, try
`utilityProcess.fork(..., { execArgv: ['--experimental-wasm-jspi'] })`, then `v8.setFlagsFromString`
plus a fresh `vm` context, as `src/shim/wasi/tests/support/jspi.ts` does. Then load the real
component in that process with a bare Node `SocketNet`. It must reach peers and answer a
`/chunks` request. The packaged-build fuses (`runAsNode`, `NODE_OPTIONS` and the inspect arguments
are off) must not block the route chosen. **If no route works, stop and report**: the plan changes.

### `src/protocols/swarm-node/` (tied to Electron: a utility process entry; README says so)

| File | Holds |
|---|---|
| `entry.ts` | The utility process: takes `start{config}`, loads the component, runs it, posts `ready`, `peers`, `failed`, and stops when it is dropped |
| `component.ts` | Loads jco output from a directory: the glue imported by file URL, each core module read and `WebAssembly.compile`d, then `instantiateComponent` with the imports below |
| `node-net.ts` | `SocketNet` over the broker's Node adapters, with the policy below; handles shaped as `src/contracts/handles.ts` (`id`, `closed`, `close()`, the streams, a `connections` stream for a server, a `Datagram` writable for UDP) |
| `node-fs.ts` | `WasiFs` over `node:fs`, confined to one directory: realpath confinement as `broker/adapters/node-fs-adapter.ts` does it, no `..` or symlink escape |
| `config.ts` | The node's YAML and arguments, from the API port and data directory; a random password generated once and stored in the data directory |
| `protocol.ts` | The messages main and this process exchange, plain data |
| `README.md` | What lives here, what it depends on (`../../shim/wasi-p2/`, `../../broker/adapters/`, `../../broker/policy/`), and what it must never import (`src/main/` beyond types) |

**Network policy at the seam.** There are no grants to lean on, so the seam is the whole defence. A
unit test proves each rule:

- `connect`: resolve the name once; every answer must be `isPublicUnicast`; dial the checked literal.
  A literal is checked the same way. Never loopback, LAN, link-local or the reserved ranges.
- `listen`: only `127.0.0.1` on the configured API port, scope `local`. Refuse any other listen.
  The WASI host then retries a `network` listen as `local`, so the node's peer-to-peer listen ends
  up on loopback, which a light node needs no more than.
- `udpBind`: loopback or any address, ephemeral port. A send goes only to a public unicast address on
  port 53.
- Limits: 300 sockets open, 4 listeners, 64 answers per lookup.
- A system proxy configured (main's `proxy-check.ts`): the node does not start. The error says
  Swarm's node would go around the proxy, as `tcp.connect` refuses (T20).

**Why a utility process is right here** goes in an ADR, `ADR-0078` (take the next free number when
you write it). ADR-0040 rejected a utility-process WASI host for app code, because app bytes
would run in unsandboxed Node. This node is not app code. It is WebAssembly, which reaches only the
imports this seam hands it. Its JavaScript glue is generated at our build and pinned by hash with the
module. A crash or a trap ends this process, never the verifier or main.

### Main side (`src/main/verifier/`)

- `swarm-node-subsystem.ts` and a lifecycle. Use `HostSupervisor` as it is (it is generic over
  `fork`, `config` and `events`); add a second rollup entry, `swarm-node-host`.
- **On demand only.** The verifier host posts `{ type: 'swarm-node-wanted' }` when a Swarm mount
  finds no ready node. Main starts the node. Main tells the verifier host
  `{ type: 'swarm-node', state: 'starting' | 'ready' | 'failed' | 'off', reason? }`. The node stops
  when the verifier host goes idle, or after 10 minutes with no Swarm mount. It restarts with the
  supervisor's backoff.
- **Readiness.** The node host polls the node's API once a second for its peer count: the node's
  `/peers` or `/topology` if they parse, else `peer_set_size=` from its log. It posts `ready` at 8
  peers or more. Within the 30 s mount deadline, the gatherer waits at most 20 s for `ready`. Past
  that, the mount fails `unavailable`, saying the Swarm node is still finding peers and to try
  again in a moment.
- **Port.** A quiet loopback port, picked like `loopback-port.ts`, passed to both hosts. The
  verifier host's `swarmEndpoints` becomes `['http://127.0.0.1:<port>']`, and `allowlisted` takes it.
  With the test seam setting endpoints, the node never starts (hermetic e2e).
- **Data.** `<userData>/swarm-node/`. Its identity persists, so the node's overlay stays stable
  and a warm restart reaches its peer snapshot in seconds.
- `status-view.ts` shows the node: off, starting, or ready with a peer count. `host-messages.ts`
  validates every new message structurally.

### The artifact

- In the private build repository: its build script builds and transpiles with jco `--name swarm-node`, the
  output exactly as `src/shim/wasi-p2/run.ts`'s `transpileCommand` gives it. Its `ASYNC_IMPORTS`
  must match this branch's `imports.ts`.
- Publish the output directory plus `LICENSE` on the owner's VPS IPFS node, pinned, with
  `~/orivon-apps/SUMMARY.md` updated there (CLAUDE.local.md section VPS; memory
  `ipfs-pinning-vps` has the recipe).
- `resources/swarm-node/swarm-node.json` pins the CID and each file's sha256.
  `scripts/fetch-swarm-node.mjs` downloads from IPFS gateways (those in `main/verifier/endpoints.ts`,
  `/ipfs/<cid>/<file>`), checks every hash, and renames into place; `postinstall` (not required)
  and every `package:*` (`--required`) run it. `electron-builder.yml` `extraResources` copies it.
  At runtime it is `process.resourcesPath/swarm-node` when packaged, `resources/swarm-node/` from
  source. A missing artifact is `off`, with the reason in plain words.
- The component is about 12.8 MB. Compile it once per process start, and measure that.

## Tests

- **Unit**: every `node-net.ts` rule, including a name whose answers mix public and private
  addresses (refused whole); `node-fs.ts` confinement; `config.ts`; the component loader against an
  existing small fixture component (`src/shim/wasi-p2/tests/fixtures/`); the message validators;
  the lifecycle (on demand, idle stop, failed, proxy off, artifact missing).
- **Live, opt-in** (`ORIVON_SWARM_NODE_LIVE=1`, never in CI): start the real node in a utility
  process through `scripts/run-headless.mjs`, wait for `ready`, fetch `swarm.eth`'s manifest
  chunk `03b80b08...` and verify it; then the whole `swarm.eth` home page through the
  gatherer.
- **e2e** stays hermetic through the seam's fixture endpoints. Add one spec: with no seam endpoint
  and no artifact, `bzz://` shows the unavailable page with its reason.
- **Cross-OS**: run `node scripts/ci/cross-os.mjs` in the background once it builds. A utility
  process with WebAssembly must start on Windows and macOS. Name the result in the PR.

## Docs

The ADR above. `src/protocols/README.md` lists `swarm-node/`. `ARCHITECTURE.md` section Where
things live gets the new process, labelled tied to Electron. `docs/architecture/security-model.md`
gets a threat row: a hostile Swarm peer, and what the seam allows. `docs/features.md` says Swarm
loads from Orivon's own node. The compatibility matrix row moves to "built". A decision-log row
records the owner's choice: local node only, WebAssembly, no public gateways.

## PR shape

One PR, `stream/swarm-node`, stacked after the Swarm protocol PR. Steps 0 and the host can start
from `origin/main`; merge `main` in once the protocol PR has merged, then wire it. Commits: probe
result (as a test or a note in the PR), host and policy, main side, artifact and fetch, wiring,
docs. Every check as `CLAUDE.md` says, heavy commands through `~/.claude/orivon-fleet/bin/heavy`.
