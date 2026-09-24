# `src/ens/`: the ENS resolver

**What lives here.** The `NameResolver` ([`../resolution/`](../resolution/)) for `.eth`: a
host checked against ENSIP-15 normalisation, the name's contenthash read through ENS's Universal
Resolver with CCIP-Read on, and the contenthash decoded (ENSIP-7) into an IPFS CID, an IPNS key, a
DNSLink domain, or a kind this build does not load.

**Not tied to Electron.** Durable. It runs in the verifier host today, but nothing here knows
that.

**What it depends on.** [`../resolution/`](../resolution/), `viem` (ENS name hashing,
normalisation, ABI coding and CCIP-Read), and `multiformats` (CIDs).

**What it must never import.** `electron`, any `node:*` module, and every other `src/` directory.
It is given an EIP-1193 provider and a CCIP-Read request function, and owns neither: the verifier
host builds a provider backed by the light client, so every answer is proven, and a request
function that decides where an offchain lookup may go.

**Owner stream.** `ens-ipfs`.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment warns about a trap a maintainer would otherwise fall into, and the argument for
a design belongs here instead.

**[`name.ts`](name.ts) refuses a host that normalisation would change.** An origin has to mean
exactly one name. If `ensNameFromHost` mapped a host to a different normalised name, two hosts
could share one name's content, or one host could come to mean another name after an
ENSIP-15 revision. A punycode (`xn--`) host is refused in this build. Chromium maps a typed
Unicode host through IDNA before Orivon sees it, and that mapping has not been checked against
ENSIP-15, so no internationalised `.eth` name resolves yet.

**[`resolver.ts`](resolver.ts) reads the contenthash at the newest block the light client has
verified, and pins every call of one resolution to it.** The record carries that block number as
its evidence. It is not the finalized block: finality lags the head by about 80 blocks, and a
public RPC serves storage proofs only for recent blocks, so a call at the finalized block failed
whenever the lag passed the RPC's proof window. The light client verifies the newest block with
the same sync-committee signatures as a finalized one; what is given up is resistance to a reorg
of the last few blocks, which could only matter for a name whose record changed in them.
*Provisional*: an RPC with a longer proof window would allow the finalized block again.

viem runs a CCIP-Read callback at `latest`, whatever block the first call named, so the resolver
wraps the provider and rewrites each `eth_call` it forwards. An offchain answer is then checked by
the resolver contract against the same state the record names.

**A Universal Resolver revert is not always a proven absence.** `ResolverNotFound` and its kin
mean the chain says there is nothing to load, which is `not-found`. `HttpError` and `ResolverError`
mean an offchain gateway, or the name's own resolver, failed; another try may succeed, so they are
`unavailable`. viem's own ENS actions treat both as "no record", which is why this file classifies
reverts itself.

**[`contenthash.ts`](contenthash.ts) decodes; it does not judge.** It turns bytes into a pointer
and refuses anything malformed. Whether a pointer can be verified (a DNSLink cannot) is
[`../resolution/pointer-chain.ts`](../resolution/pointer-chain.ts)'s question. An IPNS key is
returned in one canonical form, a CIDv1 `libp2p-key` in base36, so the same key stored two ways
is one key everywhere downstream, the highest-sequence store included.
