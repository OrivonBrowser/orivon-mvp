# `src/protocols/og/`: the `.og` resolver

**What lives here.** The `NameResolver` ([`../resolution/`](../resolution/)) for Linagee's `.og`
names, [`resolver.ts`](resolver.ts), and what it is made of:

| File | What it does |
|---|---|
| [`name.ts`](name.ts) | A `.og` host to its label, and the label to the key the registry files it under; what is refused as `invalid-name` |
| [`pins.ts`](pins.ts) | The three contracts, the one resolver implementation vouched for, its upgrade list, the event topics, the text keys read |
| [`chain.ts`](chain.ts) | The reads over an EIP-1193 provider: the newest verified block, `eth_call`, `eth_getLogs`, `eth_getStorageAt`, a transaction by hash |
| [`state.ts`](state.ts) | A name's registry, wrapper and resolver state at one block, in one `aggregate3` of Multicall3 |
| [`freshness.ts`](freshness.ts) | The rule that decides which records count: pure, no network, no clock |
| [`registry-calls.ts`](registry-calls.ts) | What a transaction did to a name in the registry, read by selector |
| [`census.ts`](census.ts), [`census.json`](census.json) | What every name with a content record looked like at a checkpoint block, and how an entry stands for the logs behind it |
| [`tail.ts`](tail.ts) | The log scans between the checkpoint and the pinned block: the newest 8,000 blocks from the light client in windows of 1024, the older stretch from the servers in windows of 9,000, kept in memory, within the time the call has |
| [`guard.ts`](guard.ts) | Whether the resolver contract still runs the implementation this build was written against |
| [`lookup.ts`](lookup.ts) | One name, from reads to verdict to records |
| [`answer.ts`](answer.ts) | A counted record's value to a `ContentPointer` |

The descriptor (`descriptor.ts`, the `.og` top-level domain) is the shell's side of the same protocol; this
README is about the resolver.

**Not tied to Electron.** Durable. It runs in the verifier host, but nothing here knows that.

**What it depends on.** [`../resolution/`](../resolution/), the `Eip1193Provider` type of
[`../ens/resolver.ts`](../ens/resolver.ts), [`../ipfs/names.ts`](../ipfs/names.ts) (the one reading of an IPFS path
an address, a DNSLink and a name's record share), [`../swarm/reference.ts`](../swarm/reference.ts), `viem` (ABI coding,
keccak-256, ENSIP-15 normalisation) and `multiformats` (CIDs).

**What it must never import.** `electron`, any `node:*` module, and every other `src/` directory. It is
given an EIP-1193 provider and owns neither the light client behind it nor any network access: the verifier
host backs the provider with the light client, so state is proven. It may be given a second provider, `servers`,
for older history that nothing proves (section What is proven and what is not).

**Owner stream.** `ens-ipfs`.

## What it answers

`resolve('alice.og')` returns one `contenthash` record per counted text record, in this order, then the registry's
own `content` slot, each read at the one block every read was made at (`provenance.via: 'chain'`, never offchain):

| Record | Becomes |
|---|---|
| `content.ipfs`: `ipfs://<cid>`, `/ipfs/<cid>` or a bare CID, each with at most one trailing `/` | `ipfs` |
| `content.ipfs`: `ipns://<libp2p key>` | `ipns-key` |
| `content.ipfs`: `ipns://<dns name>` | `dnslink` |
| `content.bzz`: 64 hexadecimal digits | `swarm` |
| `content.bzz`: 128 hexadecimal digits (encrypted) | `unsupported`, named `bzz-encrypted` |
| the registry's `content` slot, read as a sha2-256 digest of a dag-pb node | `ipfs` |
| `content.arw`, `content.magnet`, `content.ethfs`, `content.https`, `content.http`, `content.ddoc`, `contentcontract` | `unsupported`, named `arweave`, `magnet`, `ethfs`, `https`, `http`, `ddoc`, `web3` |

A value that is not a well-formed address of its kind is no record. The IPFS gatherer opens the first record it can
load, so a name with an IPFS record and an Arweave one opens the IPFS one; a name with only an `unsupported` record
fails as `unsupported`, saying which protocol. A name nobody holds, or whose records do not count, resolves to no
record (`not-found`).

A host that is not one label under `.og` is `invalid-name`, before any request: not ENSIP-15 normal, over 32 bytes,
punycode (`xn--`), or with a label before the name (`www.alice.og`: Linagee has no sub-names, so there is no name to
look up and nothing to fall back to).

**What is proven and what is not.** Proven, through the light client at the pinned block: every value a record counts
with (who holds the name, the wrapper's token, the controller, each text record's value, the registry's `content` slot)
and which contract code answers (the implementation slot). A log the light client returns from the newest 8,000 blocks
is checked against the receipts of its block. What decides which of the writes behind those values came last is read
from logs and transactions, in three stretches, and only the newest is proven:

| Stretch | From | Whose word |
|---|---|---|
| Up to the census block T | the bundled `census.json` | the bundle's, as for every release |
| T to 8,000 blocks before the newest | `OgResolverOptions.servers`: `eth_getLogs` and `eth_getTransactionByHash`, asked of the execution servers the light client uses | the servers': every log and transaction in it |
| The newest 8,000 blocks | the light client (`provider`) | a log it returns is proven; that a block holds none is the server's word, here and at any age, since no light client can prove absence |

The light client holds the hashes of the newest 8,191 blocks (about 27 hours) and can prove nothing older, so
without `servers` a name changed before them would be unavailable from the day after.

What a server that hides or invents history in the middle stretch can do, and what it cannot:

- It can make a previous holder's record count (an invented record write after the census for a name sold before it, or
  a hidden transfer), or make a fresh record not count.
- It can never make a name yield a value its current record does not store: every value is read from proven state, and
  a log counts only when it carries that value. The worst case is the rule ENS names have, that the current record
  counts, and never less; that is why a `.og` name keeps the Delivery level a proven `.eth` name gets.
- An invented `Upgraded` log makes the guard refuse `.og` names for that call only: a window that shows one is not kept.
- History the light client proved earlier in a session is asked of the servers again once it ages out of the newest
  8,000 blocks. Known, and provisional with the rest.

*Provisional.* What would settle it: a proof of old block hashes (the beacon chain's `historical_summaries` commit to
every block root), a census refreshed at runtime from a signed source, the agreement of two servers, and a logs-bloom
check of the newest blocks (the proven header's bloom shows whether a block may hold a log of the name, so a lagging
node that has not seen a transfer yet is caught). [`DESIGN.md`](DESIGN.md) section Three stretches of history gives the reasoning. A host with no
`servers` to give leaves every read to the light client.

A call that cannot be answered safely or in time fails as `unavailable` in words, never in part: the resolver
contract runs other code than the one this build vouches for, a node's answer cannot be read, or the recent history
of the name could not be checked within `budgetMs` (30 s by default; a site's mount waits 45 s for the name and its
content together), or the servers kept limiting how fast they could be asked. What was read is kept for the resolver's
life, so a reload continues from the windows already read. The light client's own failures (`not-synced`, `unverifiable`) pass through unchanged.

## Design notes

**A record counts only when its holder could have written it, and the answer fails closed.** The resolver contract
cannot say who wrote a text record, so [`freshness.ts`](freshness.ts) reads the logs. Why, what the census is, what the
guard and the tail cost, and what is left out: [`DESIGN.md`](DESIGN.md). The decision:
[`ADR-0116`](../../../docs/decisions/ADR-0116-a-og-name-opens-from-the-linagee-registry-with-only-records-its-holder-wrote.md).

**`census.json` is data, cut again at every release.** Its checkpoint block T is where the history the build trusts
ends and the servers' begins; the later the release, the more is read from the servers and the longer the first
lookup takes. [`census.ts`](census.ts) reads it and refuses a file of another format, and `guard.ts` refuses every answer
when its upgrade list is not the pinned one.

**The block is the newest the light client has verified**, as the ENS resolver reads, not a finalised one: the
execution servers prove state only for recent blocks. Windows of logs are kept only up to 64 blocks behind it.
