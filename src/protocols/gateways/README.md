# `src/protocols/gateways/`: untrusted HTTP gateways, scheduled by health

**What lives here.** The scheduling every content-addressed protocol shares when it reads from public
HTTP gateways: [`gateways.ts`](gateways.ts), a pool of gateways with a per-gateway concurrency limit
and a cooldown record, and `askGateway`, the one request that classifies whatever happens;
[`gateway-health.ts`](gateway-health.ts), how long a gateway sits out after answering badly;
[`stall.ts`](stall.ts), the clock of one transfer (a window for the first byte, a window with no byte, an outer cap); [`race.ts`](race.ts), one race across gateways for one answer (the first is asked, a second hedges it
after a delay, the first verified answer wins); and [`cache.ts`](cache.ts), verified answers kept per
partition with one in-flight fetch shared by every caller of a key, and the `BlockMemory` interface a protocol keeps them in, which may have a slower store behind its cache (`recallKept`, read on a turn of the event loop of its own; the verifier host's Swarm chunks on disk). Two small neighbours serve the verifier host and the local nodes alike: [`allowlisted-fetch.ts`](allowlisted-fetch.ts), a fetch that reaches only a list of origins and follows no redirect, and [`doh-query.ts`](doh-query.ts), one DNS-over-HTTPS query and a host's A and AAAA answers as the provider wrote them. The IPFS and Swarm protocols read
blocks and chunks through it.

**Not tied to Electron.** Durable. It runs over an injected `fetch`.

**What it depends on.** [`../resolution/`](../resolution/) only.

**What it must never import.** `electron`, `src/main/`, `src/loader/`, `src/broker/`, any `node:*`
module, and any protocol's code. It knows nothing about what a gateway serves: a protocol decides
what a verified answer is, and whether a lie was told.

**Owner stream.** `ens-ipfs`.

## Design notes

**A gateway is trusted for availability only.** Nothing here reads a body as true. The caller hashes
what `askGateway` returns and drops a gateway that lied (`GatewayPool.drop`); a gateway that is merely
slow, rate limited or unwell is cooled, and one that does not hold the item is not a strike at all.

**What earns another pass.** A rate limit, an unreachable gateway or a gateway's own 5xx earns another pass (three
passes in all), and so does a pass in which every gateway asked sent nothing within the block wait: the timed-out
gateways cool after a second timeout, so the next pass prefers the others. A timeout beside a plain 404 does not
(`failedAttempt`, `racePass`). A source whose timeout is its answer, a local node, is not passed again at once:
`retryWhileWanted` in [`fetch-passes.ts`](fetch-passes.ts) asks it again after the wait its memory needs, within a
count of tries and a time, and stops when the caller leaves. The IPFS protocol sets the figures; Swarm chunk reads
set none and count no timeout as a reason for another pass.

**A transfer fails when it stops moving, and the pool's route sets how long that is** ([`stall.ts`](stall.ts), [`../route-pace.ts`](../route-pace.ts), [`ADR-0088`](../../../docs/decisions/ADR-0088-every-wait-on-the-load-path-comes-from-the-route-it-travels.md)). `askGateway` does not give a request one wall clock from its start: the first byte has the caller's wait stretched by the route (and the route's cold start until it has carried a request), a body that has begun may go the route's `stallMs` with no byte, and the whole transfer is capped by what the largest body allowed would take at the route's rate, so a source that sends a byte a second still ends. The first byte that arrives is told to the route (`observeFirstByte`), which waits longer when requests have been slow. The hedge to a second source and the patient retry of a node (`block-fetch.ts`'s `retryOn`) follow the same route. A pool built without one is on the direct route and waits what the caller wrote.
