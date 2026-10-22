# ADR-0092: When no checkpoint is recent enough, two beacon servers that agree supply one

- **Status:** accepted, provisional on the choice of the two servers (see Reversibility)
- **Date:** 2026-10-20
- **Type:** security
- **Decided by:** owner for the feature; AI recommendation accepted by default for the rule's details (every server must agree, the wait after a failure, the choice of servers)

## Decision

**When the checkpoint the release ships and the one this install stored are both older than the 14-day limit
(`MAX_CHECKPOINT_AGE_SECONDS`), the browser asks two independent beacon servers for their finalized block
header at run time, uses the result only if both answer and give the same block root and the same slot, and
keeps it as this install's checkpoint.** The two servers are `ethereum-beacon-api.publicnode.com` and
`lodestar-mainnet.chainsafe.io`, the pair the release script `scripts/refresh-eth-checkpoint.mjs` already
requires to agree before a checkpoint is shipped. The request is a GET of `/eth/v1/beacon/headers/finalized` to
each, made together through Orivon's own request path (`ownFetch`, so a tunnel and secure DNS apply), each with a
6 s limit, when the verifier host starts (a `.eth` name typed or opened) and not before. The answer is refused
when a server is unreachable, answers with something that is not a header, says the block is not finalized,
or when the two differ; and when the agreed slot is dated more than 15 minutes after this computer's clock
(`FUTURE_TOLERANCE_SECONDS`) or is itself older than the limit. After a refusal the servers are not asked again
for 5 minutes, then 10, doubling to an hour, and at most one attempt runs at a time. A refusal leaves the "too
old" state as it is, with its reason named in Settings. A fetched checkpoint is shown in Settings with its date and
the servers that gave it, until the light client stores a newer one of its own after a sync.

## Context

`src/main/verifier/checkpoint.ts` took the newer of the release's checkpoint and the one the light client stored
after its last sync, and refused either past 14 days, which is Helios's own limit for mainnet and the weak
subjectivity period this client works inside. A fresh install of a release more than 14 days old, and an install
left idle for as long, therefore opened no `.eth` name until a newer release was installed. The release's
checkpoint is refreshed twice a week and the release workflow refuses one over 7 days, which keeps a new release
usable for a week; it does not help an old installer file or an idle install.

## Alternatives considered

- **One beacon server.** Rejected: whoever runs it, or sits between it and the browser, chooses the root the light
  client trusts. The release script already treats one server as not enough.
- **Two of three, or all of more.** Not now. Every server that must agree is a server whose outage blocks the
  renewal, and the benefit exists only when the operators are independent. Two operators is what the release
  script has relied on for each shipped checkpoint. A third independent operator with a two-of-three rule is the
  first thing that would make this stronger.
- **A checkpoint signed by Orivon, published at a fixed address.** Stronger against the servers and against a
  network attacker, and it needs a key held for this purpose, a publishing step twice a week and a place to
  serve it from. The key that signs releases (`ADR-0062`) is held offline and signs by hand, so it does not fit.
- **The checkpoint Helios carries compiled in.** About a year old; Helios neither checks its age nor warns
  loudly, and `ADR-0031` keeps it from being used.
- **Loosening the 14-day limit.** The limit is the safety property, not a nuisance: past it, a light client can
  be led onto a chain that was valid once.
- **Renewing at launch, in the background.** An idle install would then contact two servers at every launch
  whether or not a `.eth` name is ever opened. Renewing when the verifier starts keeps the requests to the moments
  the feature is used.

## Reasoning

The light client verifies every later step from the checkpoint onwards (sync committee signatures, then the
state proofs of the name's records), so the checkpoint is the one input it takes on trust. Taking it from a
single server would put that trust in one operator. Requiring two independent operators to give the same root and
slot means a single misbehaving or compromised server can deny the renewal and cannot choose the checkpoint: it
makes the two disagree, and the answer is refused. That is the same guarantee a release has had at publishing time,
now held at the moment of use.

What each party can do:

- **One server lying, wrong, or down.** The renewal fails and the install stays in the "too old" state it was in,
  with the reason shown. It cannot cause a wrong checkpoint to be used.
- **Both servers, or the network path to both, controlled by one party.** That party can name any finalized-looking
  root, including a root on a chain it built. It then also has to serve the light client's bootstrap data for that
  root, which comes from `ethereum-beacon-api.publicnode.com`, one of the two servers. So a party holding both
  servers can in principle lead a client that has no recent checkpoint onto a chain of its own and so choose what a
  `.eth` name resolves to, until the client is next given a checkpoint from another source. This is the residual
  risk, and it is the reason a third independent source is the first improvement (below). It is the same risk a
  person already accepts for every checkpoint the release script took from this pair.
- **Replaying an old answer.** Bounded by the age and clock rules: a header older than 14 days is refused, one dated
  after the clock is refused, and a checkpoint less than 14 days old is inside the period the light client is
  designed for.
- **Learning something about the person.** Each server sees a request from the person's address (or the tunnel's)
  asking for the finalized header, at a moment a `.eth` name was opened on an install whose checkpoint had aged out.
  It sees no name and no site.

The servers are asked for the finalized header in one request each (`/eth/v1/beacon/headers/finalized`) because the
answer carries the block root and its slot together, and a server may not set `canonical` or
`execution_optimistic` against the answer. It is accepted when those are absent, since the request itself names
the finalized block and not every server includes the flags. The `finalized` flag counts against an answer only
when no other server sets it true for the same root and slot: Lodestar sets it false on the block it names as
finalized, which refused every renewal while it was one of the pair.

## Consequences

- A fresh install of an old release, and an install idle past 14 days, opens `.eth` names again as long as both
  servers answer and agree. The first `.eth` open after that waits for the renewal, at most about 6 s more, and the
  requests held for the verifier host wait for it too.
- Two more servers are contacted, by an install that has no recent checkpoint, at a `.eth` open. They are listed in
  `docs/privacy/outbound-requests.md`, the privacy notice and Settings.
- `scripts/refresh-eth-checkpoint.mjs` (JavaScript) and `src/main/verifier/checkpoint-fetch.ts` (TypeScript) hold
  the same rule twice, because a script cannot import the TypeScript; a unit test runs the same answers through both
  and compares the verdicts, and compares their server lists.
- Finality moves every few minutes, so two honest servers can briefly differ; the renewal then fails and is tried
  again after the wait. A person offline, or behind a network that blocks the two servers, stays in the "too old" state.
- A fetched checkpoint is kept in `checkpoint.json` beside the light client's own, with the servers that agreed; if the
  profile cannot be written, the renewal is made again at the next start.

## Reversibility

- **Cost to reverse:** cheap. The behaviour is one module, one call in the verifier subsystem and a file field; removing
  it returns to refusing an aged-out checkpoint.
- **What would make us revisit:** a third independent operator that serves the beacon API (then two of three agreeing,
  and a pair that does not include the light client's own consensus server); a checkpoint signed by a key held for the
  purpose; or a report that the pair disagrees often enough, when both are healthy, to block the renewal. The choice of
  these two servers is *provisional*: what settles it is a month of the renewal's outcomes from installs that needed
  it, which this build does not collect.
