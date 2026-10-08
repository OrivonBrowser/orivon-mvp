# `src/protocols/ens/`: the ENS resolver

**What lives here.** ENS's descriptor ([`descriptor.ts`](descriptor.ts): the `.eth` top-level
domain), and the `NameResolver` ([`../resolution/`](../resolution/)) for it: a host checked
against ENSIP-15 normalisation, the name's contenthash read through ENS's Universal Resolver with
CCIP-Read on, and the contenthash decoded (ENSIP-7) into an IPFS CID, an IPNS key, a DNSLink
domain, or a kind this build does not load.

**Not tied to Electron.** Durable. It runs in the verifier host, but nothing here knows that.

**What it depends on.** [`../resolution/`](../resolution/), `viem` (ENS name hashing,
normalisation, ABI coding and CCIP-Read), and `multiformats` (CIDs).

**What it must never import.** `electron`, any `node:*` module, and every other `src/` directory.
It is given an EIP-1193 provider and a CCIP-Read request function, and owns neither: the verifier
host backs the provider with the light client, so every answer is proven, and decides where an
offchain lookup may go.

**Owner stream.** `ens-ipfs`.

## Design notes

**[`resolver.ts`](resolver.ts) proves at the newest verified block, not the finalized one**
([`ADR-0030`](../../../docs/decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md)
section Decision, *provisional*). What it gives up is resistance to a reorg of the last few blocks, which
could only matter for a name whose record changed in them.

**Do not swap in viem's own ENS actions.** They read every Universal Resolver revert as "no
record"; [`resolver.ts`](resolver.ts) tells a proven absence (`not-found`) from a failed offchain
gateway or resolver (`unavailable`).
