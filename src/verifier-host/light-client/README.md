# `src/verifier-host/light-client/`: proving a `.eth` name

**What lives here.** `light-client.ts` (Helios, behind one EIP-1193 provider), `helios-errors.ts`
and `rpc-failover.ts` (trying execution RPCs in turn per request).

**What it depends on.** [`../egress.ts`](../egress.ts), [`../protocol.ts`](../protocol.ts) and
`@a16z/helios`.

**What it must never import.** [`../../main/`](../../main/) beyond type-only imports -- see the
parent README's "What it must never import".

**Owner stream.** `ens-ipfs`.

## Design notes

**The light client needs four wrappers** ([`light-client.ts`](light-client.ts),
[`helios-errors.ts`](helios-errors.ts), [`rpc-failover.ts`](rpc-failover.ts)). A
`WorkerGlobalScope` shim, or its WebAssembly timer panics on the first failed consensus request.
A URL on every response, because Electron's `net.fetch` leaves it empty and Helios throws from
inside its WebAssembly when it parses one. Its revert text turned into `{ code: 3, data }`, or
viem never sees a CCIP-Read `OffchainLookup`. And execution RPCs tried in turn per request: one
RPC per instance, as Helios takes, fails whenever that RPC's proof window is short, and since
every answer is verified, which RPC gives it changes nothing about trust.

**One failed refresh does not un-sync the client** ([`light-client.ts`](light-client.ts)). The
head is re-read on a timer; a failed read leaves the client reporting `synced` while the last
proven head is under two minutes old, since that head is still a real, usable proof, and a single
bad RPC call must not fail every `.eth` mount for up to a minute. Past two minutes, or on a second
failure with no success between, the client drops to `syncing` and the next request waits for a
real answer, as it always did. Reading the finalized-block checkpoint (a separate RPC call, kept
only so the shell can persist a newer one) never affects sync state either way.
