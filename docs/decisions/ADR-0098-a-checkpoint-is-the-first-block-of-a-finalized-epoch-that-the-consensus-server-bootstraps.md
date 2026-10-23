# ADR-0098: A checkpoint is the first block of a finalized epoch that the consensus server bootstraps

- **Status:** accepted. Amends [`ADR-0092`](ADR-0092-when-no-checkpoint-is-recent-enough-two-beacon-servers-that-agree-supply-one.md): which block a fetched or shipped checkpoint is, and that a checkpoint the beacon server will not bootstrap is given up at once. The rest of ADR-0092 stands.
- **Date:** 2026-10-23
- **Type:** security
- **Decided by:** AI recommendation accepted by default (a release-blocking fault: a fresh install loaded no `.eth` name)

## Decision

**A checkpoint, whether the release script picks it or the browser fetches it, is the block at the first slot of a
finalized epoch, and is accepted only when `ethereum-beacon-api.publicnode.com` (`DEFAULT_ENDPOINTS.consensusRpc`, the
server the light client bootstraps from) answers its bootstrap with 200 and a header at that slot.** The two servers
first agree on the finalized head as before. The candidate is the head's epoch start; when that slot holds no block, or
the consensus server answers 404 to the bootstrap of its root, the search steps back one epoch at a time, at most eight
epochs. The consensus server is asked for the root at the slot and then the bootstrap; every other server must name the
same root at that slot, or the answer is refused as disagreement. A server that cannot be reached, or answers something
unreadable, fails the attempt instead of being stepped past. Only the consensus server is asked for a bootstrap.

**When the light client fails with a 404 for the bootstrap of the checkpoint it started from, that root is not chosen
again in this run and a fresh checkpoint is fetched at once**, within the existing wait after a failed attempt (5
minutes, doubling to an hour). On success the host is put to sleep and started again with the new checkpoint, which is
stored and outranks the release's from then on.

## Context

A beacon server's finalized head is the finalized checkpoint's block: the block at the first slot of the epoch, or,
when that slot holds no block, the block before it, which is the last slot of the epoch before. Servers serve a
light-client bootstrap for the first kind. The checkpoint shipped with v0.0.10 was the second kind, at slot 15489055:
`ethereum-beacon-api.publicnode.com` answered 404 to its bootstrap ("not a finalized checkpoint") though it reported the
block finalized and canonical, while Lodestar answered 200. The light client bootstraps from publicnode
only, so on a fresh install of that release no `.eth` name loaded. The checkpoint was a day old, so the 14-day rule never
renewed it: ADR-0092's renewal starts only once the release's and the stored checkpoint are both past the limit. Neither
the release script nor the run-time fetch ever asked whether the root could be bootstrapped from.

## Alternatives considered

- **Bootstrap from every checkpoint server.** Rejected: Lodestar serves a bootstrap for blocks publicnode does not (and
  the reverse), and the light client uses only publicnode. Requiring a bootstrap of the others refuses roots that serve
  the light client, and the others exist to vouch for the root, not to serve it.
- **Probe the bootstrap only in the release script.** Rejected: the install in the field had no way out, and a
  server's pruning can make a good checkpoint unbootstrappable later.
- **Change the light client's consensus server to one that serves the head.** Rejected: it swaps one server's quirk for
  another's, and leaves the same gap for the next change in either.
- **Renew by the 14-day rule alone, with a shorter limit.** Rejected: a shorter limit weakens nothing and fixes nothing
  here; the fault is a checkpoint that was never usable, not one that was old.
- **Take the root at a slot from the headers path.** Rejected: Lodestar answers it only by root, not by slot; the
  block-root path answers by slot on both servers.

## Reasoning

The light client verifies everything after the checkpoint, so which block it starts from is a question of availability,
not of trust, once two servers agree on the root. Taking the first block of an epoch, and checking with the one server
the client uses that it bootstraps from it, makes the shipped and the fetched checkpoint the kind the client can start
from. The bootstrap's header slot is compared with the epoch's first slot, so a server that answers with the previous
block's root for an empty slot (Lodestar does) cannot pass a root of another slot. Giving up a root on the 404 covers
the cases no check at build time can: a checkpoint that worked when shipped and was pruned since, and an old release
already in the field.

Cost: a renewal now makes up to three requests to the consensus server and one to each other, in sequence after the
head, not one to each in parallel. At the worst a renewal takes a few of the 6 s request limits; the usual case is a
second.

## Consequences

- A release's checkpoint is the epoch start picked by `scripts/refresh-eth-checkpoint.mjs`, whose output is up to one
  epoch (about 6 minutes) older than the head; the 7-day release rule is unaffected.
- `scripts/refresh-eth-checkpoint.mjs` and `src/main/verifier/checkpoint-fetch.ts` still hold the rule twice, compared by
  one unit test.
- An install whose bundled checkpoint is not bootstrappable recovers in the run it fails in, with two extra requests
  to each server that run, and stores the renewed checkpoint for the next.
- Two more request paths are made to the beacon servers (`docs/privacy/outbound-requests.md`); the servers and the
  trigger's meaning are the same, plus the 404 case.

## Reversibility

- **Cost to reverse:** cheap. One function in each of two files and one status hook.
- **What would make us revisit:** the light client bootstrapping from a server that serves bootstraps for any finalized
  head, or a second consensus server the client can fall back to (then the probe is of whichever it starts from).
