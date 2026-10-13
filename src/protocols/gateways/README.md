# `src/protocols/gateways/`: untrusted HTTP gateways, scheduled by health

**What lives here.** The scheduling every content-addressed protocol shares when it reads from public
HTTP gateways: [`gateways.ts`](gateways.ts), a pool of gateways with a per-gateway concurrency limit
and a cooldown record, and `askGateway`, the one request that classifies whatever happens;
[`gateway-health.ts`](gateway-health.ts), how long a gateway sits out after answering badly;
[`race.ts`](race.ts), one race across gateways for one answer (the first is asked, a second hedges it
after a delay, the first verified answer wins); and [`cache.ts`](cache.ts), verified answers kept per
partition with one in-flight fetch shared by every caller of a key. Two small neighbours serve the verifier host and the local nodes alike: [`allowlisted-fetch.ts`](allowlisted-fetch.ts), a fetch that reaches only a list of origins and follows no redirect, and [`doh-query.ts`](doh-query.ts), one DNS-over-HTTPS query and a host's A and AAAA answers as the provider wrote them. The IPFS and Swarm protocols read
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
