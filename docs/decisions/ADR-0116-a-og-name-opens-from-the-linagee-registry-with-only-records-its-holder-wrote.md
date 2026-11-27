# ADR-0116: A `.og` name opens from the Linagee registry, with only the records its holder wrote

- **Status:** proposed. Three parts are *provisional*, named in the Decision.
- **Date:** 2026-11-27
- **Type:** architecture / security
- **Decided by:** owner, that `.og` names open in the browser with the functions the `.eth` names have. AI
  recommendation, for the mechanism: a built-in resolver, the freshness rule, the census and the tail.

## Decision

`.og` is a built-in protocol beside ENS, in `src/protocols/og/` (durable, no Electron): a `NameResolver` for the
`.og` top-level domain that reads Linagee's contracts over the light client's EIP-1193 provider, so every value a record
counts with is proven (`ADR-0031`), at the one newest block the light client has verified, as the ENS resolver does
(`ADR-0030`). The history that says which write came last is only partly proven: the next bullets say which part.

- **A record counts only when its holder could have written it (C1).** A text key counts when the name's controller
  is zero or the holder, and the latest `SetTextRecord` log of that key carries the value now stored and comes after
  the latest change of holder and the latest `NewController`. The registry's own `content` slot counts only for a
  direct `setContent` after the latest change of holder, on a name that is not wrapped. A name the wrapper holds with no
  token behind it has the wrapper for its holder, which never writes, so no text key of it counts. A change of holder is any
  registry `Changed` log except a direct content, address or sub-registrar write read from its transaction, and a
  wrapper `Transfer` to the current holder; a call that cannot be read is a change of holder. Every doubt resolves to
  "no record".
- **The resolver contract is pinned.** Every answer needs the proxy's ERC-1967 implementation to be the pinned one,
  the census's upgrade list to equal the pinned list, and no `Upgraded` log after the census checkpoint.
- **History is three stretches, and only the newest is proven.** Up to a checkpoint block T it is a bundled census
  (`census.json`: for each name with a content record, what its logs said at T), the build's word, re-cut at every
  release. From the newest 8,000 blocks to the newest block it is the light client's, which proves a log against the
  receipts of its block; that a block holds no log, at any age, is the server's word, since no light client can prove
  absence. Between them it is the execution servers' word, unproven: the light client proves a block only while its hash
  is in the chain's ring of the newest 8,191 (EIP-2935, about 27 hours), so the logs there, and the transactions behind
  the registry logs there, are asked of the servers the light client uses, through the same route and failover, in
  windows of 9,000 blocks, two at a time, with a rate limit waited out and a range refused as too wide halved. The
  resolver answers only when the whole range is covered within the call's time: a scan that runs out of time fails as
  `unavailable`, never answers in part, and a reload continues from the windows kept.
- **What a lying server can and cannot do.** Every value a record counts with, the holder, the controller and the
  implementation are read from state at the pinned block through the light client, so they are proven. A server that
  hides or invents logs or transactions in the middle stretch can make a previous holder's record count (an invented
  record write after the census for a name sold before it, or a hidden transfer), or make a fresh one not count. It can
  never make a name yield a value its current record does not store, because a log counts only when it carries the
  proven stored value. The worst case is the rule ENS names have, that the current record counts, and never less; that
  is why `.og` keeps the Delivery level a proven `.eth` name gets. An invented `Upgraded` log makes the guard refuse
  `.og` names for the calls waiting on that read. *Provisional*: the census and the servers are trusted for their stretches, history
  the light client proved earlier in a session is asked of the servers again once it ages out of the newest 8,000
  blocks, and what would settle it is a proof of old block hashes (the beacon chain's `historical_summaries`), a census
  refreshed at runtime from a signed source, the agreement of two servers, or a logs-bloom check of the newest blocks.
- **A name opens what this build loads.** An IPFS path becomes an `ipfs` pointer, an IPNS key an `ipns-key`, a DNS
  name a `dnslink`, a Swarm reference a `swarm` pointer, and the registry's `content` slot (a sha2-256 digest of a
  dag-pb node) an `ipfs` pointer. Arweave, `web3://`, HTTP and HTTPS, magnet, EthStorage and DDoc records are
  `unsupported` and named, so a name with an IPFS record next to an Arweave one opens the IPFS one. *Provisional*:
  which of these a later build loads.
- **A host is one label under `.og`**, ASCII, ENSIP-15 normal, at most 32 bytes, not punycode. Anything else,
  including `www.alice.og`, is `invalid-name` before a request is made: Linagee has no sub-names.
- **The resolver only reads.** Registering, transferring and setting records are the site's work, with the person's
  own wallet.

## Context

Linagee's `.og` names are Ethereum names, older than ENS, held in a 2015 registry and (for names registered since
2022) wrapped as ERC-721 tokens, with their records in an upgradeable resolver. The ENS resolver of this build cannot
read them: they have another registry, another record layout and no Universal Resolver. The same people who hold
`.og` names hold `.eth` names, and a `.og` name is useful only if it opens like one.

The registry has one property ENS does not give a reader: it keeps no record of who wrote a text record. A record
written by a seller, a previous controller or a holder who no longer holds the name is still stored, and
`getTextRecord` returns it. A reader that opened it would open a stranger's site under a name the visitor trusts,
and the trust a `.og` name carries is the point of the name. So the resolver has to read events and apply a rule, and
the events of a decade are more than a page load can walk.

## Alternatives considered

- **Read `getTextRecord` and the registry's `content` slot as state.** Cheapest, one `eth_call`. It opens a seller's
  record for the new holder's name. Rejected as unsafe, not as slow.
- **A trusted indexer or API answers.** Fast and complete. It puts a server the visitor cannot check in front of every
  `.og` name, which this build's name resolution does not do for `.eth` (every answer is proven by the light client),
  and it fails when the server does.
- **Scan the whole history on every first look.** Correct without a census, but a scan of the registry's decade is
  not a page load, and the servers that answer archive logs refuse or rate limit a client that tries. Rejected for the
  time.
- **Only the light client, with a census that is always recent.** Everything proven, no unproven stretch. A name
  changed more than 27 hours after the census would have no history the light client can read, so a release is
  correct for a day and a name set after it fails from the next. Rejected: the names a launch exists for are the ones
  set after its census.
- **A server of ours that serves the history.** One answer for every client, with the proof problem unchanged and a
  server every client must trust and cannot replace. Rejected: the execution servers the light client already
  uses are the ones the person can name themselves.
- **A census with no tail.** Instant. It answers as of T, so a transfer after T leaves the seller's record counting,
  which is the failure C1 exists to prevent. Rejected.
- **Answer in part when the scan runs out of time.** A name opens at once, most of the time correctly. The windows not
  yet read are exactly where a transfer would be, so a partial answer is wrong in the case that matters. Rejected: a
  reload continues from the kept windows instead.
- **Trust the resolver contract whatever it runs.** It is behind an upgradeable proxy, so its rules can change after
  this code is written. Rejected: the pinned implementation is the one C1 was written against.
- **The finalised block for every read.** Resistant to a reorg of the last blocks. Execution servers prove state only
  for recent blocks, so a finalised tag may name a block they cannot prove, and the ENS resolver already chose the
  newest verified block for the same reason. Rejected for the same reason.

## Reasoning

C1 is the smallest rule under which a reader cannot be sent to a stranger's site, and failing closed keeps the cost
of every error a missing page. The census makes the rule affordable: the part of history no page load could walk is
bundled once per release and checked by anyone who fetches the same logs. The tail keeps the answer current to the
block the light client proved, and refusing in words when it cannot finish keeps a slow connection from turning into
a wrong answer. Reading the old stretch from the servers is the one place the build takes a server's word for
something the light client would have proven, and it is taken where the alternative is a name that works for a day: what
a server can do with it is bounded by C1 against proven values. It can make a previous holder's record count or a fresh
one not count; it can never make a name point to content its current record does not hold, which leaves the worst case at
the rule ENS names have.

## Consequences

- A release carries a census cut just before it, and `scripts/og-census/` is how it is cut. A build with an old census
  is not wrong: the stretch between the census and the newest blocks is the servers' word, longer the older the
  census, so a stale census is a release defect and a test (`src/protocols/og/tests/`) holds the shipped census to the
  pinned upgrade list.
- Old history is the servers' word. A server that hides or invents history can make a name that was sold keep its previous
  holder's site, or hide a record; it cannot point a name at content its current record does not hold, because every
  value is checked against proven state. The worst case is what an ENS name has by construction, so a `.og` name keeps the
  Delivery level a proven `.eth` name gets. A person who names their own servers is trusting their own.
- The light client's route carries a new kind of request to its servers (`eth_getLogs` over wide ranges, and
  transactions by hash) from the `og` resolver only, through the existing failover.
- The contract owner upgrading the resolver makes every `.og` name `unavailable` until a build pins the new
  implementation. Deliberate: the alternative is opening records under rules nobody has read.
- A name whose controller is a third party (a marketplace, a service) shows no text record until the holder takes the
  controller back; the registry's `content` slot, which only the holder can write, still counts.
- Sub-label hosts and names the address bar would normalise differently fail with a reason before any network use.
- The resolver adds `viem` and `multiformats` imports it already shares with ENS, and no dependency.

## Reversibility

- **Cost to reverse:** moderate. The resolver and its census are one directory; removing `.og` removes it and a
  descriptor. A name opened under C1 changes nothing on chain, so there is no data to migrate.
- **What would make us revisit:** the resolver contract being replaced by one that records the writer of a record (C1
  then reads that instead of the logs); a proof of old block hashes the light client can check (the beacon chain's
  `historical_summaries`) or a census refreshed at runtime from a signed source, either of which makes the old stretch
  proven or short; a measurement of the shipped servers that moves the widths or the number in flight.
