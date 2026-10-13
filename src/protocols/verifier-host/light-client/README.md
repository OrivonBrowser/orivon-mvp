# `src/protocols/verifier-host/light-client/`: proving a `.eth` name

**What lives here.** `light-client.ts` (Helios, behind one EIP-1193 provider), `helios-errors.ts`
and `rpc-failover.ts` (trying execution RPCs in turn per request).

**What it depends on.** [`../egress.ts`](../egress.ts), [`../protocol.ts`](../protocol.ts) and
`@a16z/helios`.

**What it must never import.** [`../../../main/`](../../../main/) beyond type-only imports, as the
parent README says.

**Owner stream.** `ens-ipfs`.

## Design notes

**Helios needs four wrappers**
([`ADR-0031`](../../../../docs/decisions/ADR-0031-helios-is-the-light-client.md) section Decision): a
`WorkerGlobalScope` shim, or its WebAssembly timer panics on the first failed consensus request; a
URL on every response, since Electron's `net.fetch` leaves it empty and Helios throws parsing it;
its revert text as `{ code: 3, data }`, or viem never sees a CCIP-Read `OffchainLookup`; and
execution RPCs tried in turn, or one RPC's short proof window fails the name.

**One failed head refresh leaves the client `synced`; a second in a row, or a proven head over two
minutes old, does not** (ADR-0030's 2026-09-26 amendment). A checkpoint read never changes sync
state.

**A second client proves the names of tunnel-profile websites, in the same process.** Helios reaches the network only through the process's global `fetch`, and a request names no website, so one client cannot take a route per call. `light-client.ts` replaces `globalThis.fetch` once with a dispatcher that holds a lane per client: the shared client keeps the real server addresses, and the tunnel's client is told `https://tunnel-execution.orivon.invalid` and `https://tunnel-consensus.orivon.invalid` for its two servers. The dispatcher maps a request back to the real server and sends it on that client's own allowlisted fetch (the routed fetch for the tunnel's), and refuses any other address. The tunnel's client starts at the first tunnel-profile `.eth` name, reports no status to the shell, and its sync runs wholly through the tunnel, which is slow to open the first time: that name can answer "still syncing; reload in a moment" once.
