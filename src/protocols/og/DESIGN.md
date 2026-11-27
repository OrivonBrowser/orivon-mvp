# `.og` resolver: design

Why [`resolver.ts`](resolver.ts) answers as it does. What it does and where each part lives is in
[`README.md`](README.md); the decision is
[`ADR-0116`](../../../docs/decisions/ADR-0116-a-og-name-opens-from-the-linagee-registry-with-only-records-its-holder-wrote.md).

## The problem: nothing says who wrote a record

A `.og` name is a key in the Linagee registry (2015, immutable), optionally wrapped as an ERC-721 token, and its
records live in an upgradeable resolver contract. The resolver stores a text record per key and keeps no record of
who wrote it: the controller of a name (whom the holder may name, and who may then write text records) and the holder
are different powers, and a name changes hands with its records still on it. Reading `getTextRecord` therefore gives
a value that may have been written by a seller, a previous controller or a holder who no longer holds the name.
Opening that value as the name's site would hand a visitor to whoever wrote last, not to whoever holds the name.

So a record is read as an event, never as state alone: the answer is what the holder, and only the holder, put there.

## C1: when a record counts, and why it fails closed

A text key counts only when all of these hold at the pinned block:

1. the name has a holder who can write: the wrapper's token owner for a wrapped name, the registry's owner otherwise. A name
   the wrapper holds with no token behind it has the wrapper for its holder, which never writes, so no text key of it counts;
2. the resolver's controller for the name is zero or the holder;
3. the latest `SetTextRecord` log of that key carries the value stored now;
4. that log comes after the latest change of holder, and after the latest `NewController`.

The registry's own `content` slot counts only when a direct `setContent` of the value now stored came after the latest
change of holder, on a name that is not wrapped: a transfer leaves the slot to the next holder, so a slot that no one
has written since the transfer is the seller's.

A change of holder is any registry `Changed` log, except one whose transaction is read and is a direct call of
`setContent`, `setAddress` or `setSubRegistrar` on the name (by selector, exact input length, same key: those change
the name's content, not its owner), and a wrapper `Transfer` to the holder the name has now for a wrapped name. A
`Changed` log whose transaction could not be read, or was read and is anything else (a call through a contract, an
unknown selector, input that does not decode), counts as a change of holder.

The direction of every doubt is the same: **a record that cannot be shown to be the holder's is no record**. The rule
errs toward a name that opens nothing (`not-found`) rather than a name that opens a stranger's site, because the
first is a missing page and the second is a phishing page under a name a person trusts. [`freshness.ts`](freshness.ts)
is pure (no network, no clock), so a vector in a test is the rule and the resolver and the census tool run one
function.

## The guard: the resolver contract is code that can change

The resolver sits behind an ERC-1967 proxy, so its rules can be changed by whoever holds the upgrade key, and C1 is
written against the one implementation this build vouches for. [`guard.ts`](guard.ts) refuses every answer unless:

- the proxy's implementation slot, read at the pinned block, is the pinned implementation;
- the census's list of upgrades equals the pinned list, entry for entry, so a census cut against another history is
  never read as this one;
- no `Upgraded` log appears after the census checkpoint (one scan of the tail, shared by every name).

A resolver that fails the guard is `unavailable`, in words that say the contract runs other code than this build was
written against. The pinned implementation is changed by a new build, after someone has read the new code against C1.

## The census: trusted up to a checkpoint

Walking a name's whole history is a scan of every log of the registry and the resolver since 2015, which is far past
what a visitor would wait for. [`census.json`](census.json) is the shortcut: for every name that has ever had a content
record, what its logs said at a checkpoint block T (the latest text log of each key, the controller and holder changes,
and for each registry change whether it was a direct content write), cut by the census tool, `scripts/og-census/`, by
reading the same logs and applying the same rule. [`census.ts`](census.ts) stands those entries in for the logs before
T, so the resolver reads only what came after.

The census is **trusted up to T and no further**: a reader of this repository must believe it as it believes the
pinned implementation, because nothing in the browser can check an event of 2019 at the speed of a page load. Its
risk is bounded by how it is made: every release re-cuts it, so T moves to just before the release, and it is cut
from logs a person can fetch from any archive node and compare. A name absent from the census is not an error: it had
no content record at T, and everything it did after T is scanned. A census of another format, or one whose upgrade list
is not the pinned one, is refused.

## Three stretches of history

After T the history is read in two more stretches, because the light client can prove only part of it. What each
stretch is, and whose word it rests on:

1. **Up to T**: the census, the build's word.
2. **From T to 8,000 blocks before the newest block (the old stretch)**: the execution servers' word. Helios proves a
   block only while its hash is in the chain's own ring of the newest 8,191 block hashes (EIP-2935, about 27 hours),
   and fails any older log, transaction or receipt with "outside the ring buffer range". So the logs of the
   old stretch, and the transactions behind its registry logs, are asked of the execution servers the light client
   uses, through the same route and the same failover, by `OgResolverOptions.servers`
   ([`server-reads.ts`](../verifier-host/light-client/server-reads.ts) in the verifier host). That provider
   carries `eth_getLogs` and `eth_getTransactionByHash` and nothing else: no state is ever read this way.
3. **The newest 8,000 blocks**: the light client. A log it returns is checked against the receipts of its block, so it
   is proven. That a block holds no log is the server's word, in this stretch and in every other: no light client can
   prove absence.

The windows are cut on a grid: the light client's stretch starts at a multiple of 1024 within 8,000 blocks of the newest,
so two calls made a few blocks apart ask the same windows and the kept ones are used again.

**What a lying server can do** is to hide a log or a transaction, or to invent one, anywhere in the old stretch. So it can
make a record that C1 would refuse count (an invented record write after the census for a name sold before it, or a
hidden transfer, leaves the previous holder's record in force), or make one that C1 would count not count. It cannot make
a name yield a value its current record does not store: the value of every key, the holder, the controller and the
implementation are read at the pinned block through the light client and proven, and a log that does not match the proven
value does not count (C1 step 3). The worst case is the rule ENS names have, that the current record counts, and never
less; that is why `.og` keeps the Delivery level a proven `.eth` name gets. An invented `Upgraded` log makes the guard
refuse `.og` names for that call only, and a window that shows one is not kept. The servers are the ones the light client's
own requests go to, so a person who named their own servers gets their own word.

**Known, and provisional with the rest:** history the light client proved earlier in a session (a window of the newest
8,000 blocks) is asked of the servers again once it ages out of that stretch.

This is *provisional*. What would settle it: a proof of old block hashes (the beacon chain's `historical_summaries` commit to
every block root, and an execution block hash can be checked against them); a census refreshed at runtime from a signed
source; the agreement of two servers; a logs-bloom check of the newest blocks (the proven header's bloom shows whether a
block may hold a log of the name, so a lagging node that has not seen a transfer yet is caught). The first two make the old
stretch proven or short, the others narrow what a server can get away with. Until then the old stretch is the servers' word,
and the README, this file and the decision say so.

## The tail: the cost of the time since T

The resolver scans the logs for the name itself (a topic filter, so no other name's logs are fetched), in windows that
fit what each source answers:

- **Light client**: windows of 1024 blocks, the widest range a log query covers in this client, up to eight in flight,
  taken in chain order. Helios fetches the receipts of each block that has a log, so the window is kept narrow.
- **Servers**: windows of 9,000 blocks, under the 10,000 the widest of them answers, two in flight (the servers
  that serve archive logs rate limit bursts: HTTP 429, Cloudflare's "error code: 1015"). A server that refuses a range as too wide (a limit
  on the range, a "too many" message, code 35) is read as the two halves of the range while each half keeps at least
  1024 blocks; a narrower refusal fails the window. A 429, or a 503 that names a wait, waits for what the server asked
  (at least a second, doubling to a cap of eight when it asked for nothing) and asks again, up to five times; a wait
  longer than the call has left refuses at once. While one read waits, every read of the servers waits with it. A
  server read ends within 25 s, and the turn it holds is given back at the call's deadline even while it runs, so a
  hung server does not hold the next call's turns. A server that refuses the archive part of its service (HTTP 403) is passed over by the
  failover for another, which is why the provider is given the failover and not one server.

A window at or below `final` (the newest block less 64) cannot be reorganised and is kept in memory for the resolver's
life, under its source, so a second name, or a reload, scans only what is new. A window above `final` is read again,
and so is a servers' window that made a scan refuse (an `Upgraded` log), so one invented answer refuses one call only.

- A call has a budget (`budgetMs`, 30 s by default, inside the 45 s a mount waits on a direct route). The scan stops
  starting windows when the rest of the budget cannot cover one more at the pace measured for its source (with a
  reserve of 2 s to finish the answer), and fails the call as `unavailable` in words that say the recent history could not
  be checked in time.
- **A scan never answers in part.** Records read from the windows seen so far could be stale in exactly the way C1 is
  written to refuse (a transfer in a window not yet read would leave the seller's record counting), so a partial scan
  is no answer. A reload continues from the kept windows, so a slow route that cannot finish in one call finishes in
  a few.
- Transactions behind registry `Changed` logs are read newest first, four at a time, until one is a holder change:
  the newest holder change settles every older log, so a name with one transfer and many content writes after it
  reads only what came after the transfer. A transaction is read from the servers when its block lies in the old stretch,
  and kept only when its block is at or below `final` and is the block its log claims. The light client's transactions
  and the servers' are kept apart: an answer from the servers never stands for a transaction the light client is asked
  for, so a log a server invents cannot lend its forged transaction to a real log with the same hash.

The cost of an old census is now time and not a wall: a name changed since T, however long ago, is still
resolved, from the servers, in as many windows as there are 9,000 blocks (a day and a half) since T, two at a
time. The census is still re-cut at every release, because the fewer blocks lie between T and the newest, the
smaller the unproven stretch and the faster the first lookup.

## One block for every read

Every read of state in one resolution is made at the newest block the light client has verified, so the holder, the
controller, the records and the guard agree; the logs end at the same block. This is the ENS resolver's trade-off: the execution servers
prove state only for recent blocks, so a finalised tag would ask for a block that may be past what they prove. What is
given up is resistance to a reorg of the last few blocks, which could only matter for a name that changed in them; the
tail keeps nothing it read above `final`.

## What is left out

- Everything that writes (setting a record, registering, transferring): the resolver only reads.
- A `.og` name's sub-names: Linagee has none, so a host with a label before the name (`www.alice.og`) is
  `invalid-name`, never looked up as its parent.
- Records of a kind this build cannot load (Arweave, `web3://`, HTTP and HTTPS, magnet links, EthStorage, DDoc, encrypted Swarm references) are
  returned as `unsupported` records naming the protocol, so a name with only those says what it holds and a name with
  an IPFS or Swarm record next to them opens that one.
- Names written in a script ENSIP-15 does not normalise to, and punycode labels: the address bar is ASCII, and a
  label that is not normal is a different name from the one a person sees.
