# `src/protocols/verifier-host/`: the process that serves every protocol's pages

**What lives here.** The verifier host: an Electron utility process that runs every protocol's
providers ([`protocols.ts`](protocols.ts)), proves `.eth` names with a light client
([`light-client/`](light-client/)), gathers IPFS content block by verified block and Swarm content chunk by verified chunk, and serves it to
tabs from a loopback TLS server ([`serve/`](serve/)). Every untrusted parser (the light client's
WebAssembly, CCIP-Read answers, IPNS protobuf, dag-pb, DNS-over-HTTPS JSON) runs here, never in
the main process.
[`ADR-0030`](../../../docs/decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md) is
the design; [`ADR-0031`](../../../docs/decisions/ADR-0031-helios-is-the-light-client.md) admits
Helios.

**Tied to Electron.** Disposable. [`entry.ts`](entry.ts) is the utility-process entry and the one
file that imports `electron`; [`service.ts`](service.ts) takes Electron's `net` and the parent port
as arguments, so everything else runs under plain vitest.

**What it depends on.** [`../resolution/`](../resolution/), [`../ens/`](../ens/),
[`../ipfs/`](../ipfs/), [`../swarm/`](../swarm/); from [`../../loader/`](../../loader/) the range parser, the content-type
map and the redirect rule, and from [`../../broker/policy/`](../../broker/policy/) the address
classifier, all reused rather than copied; `@a16z/helios`.

**What it must never import.** [`src/main/`](../../main/) beyond type-only imports: main starts it
and talks to it over [`protocol.ts`](protocol.ts), and nothing else.
[`../../main/verifier/`](../../main/verifier/) is its other side.

**A local node is asked for before each mount that reads from it.** [`node-link.ts`](node-link.ts) serves any
kind of node by its name (`NodeLinks.to`). When `HostConfig.swarmNode` is set, the Swarm endpoint is the node
Orivon runs ([`../swarm-node/`](../swarm-node/)): the link posts `node-wanted` to main on every mount (which
keeps the node's ten-minute idle wait from running out under use) and holds the mount up to twenty seconds for
main's `node` notice, then fails it `unavailable` in plain words: off or failed with the reason, or still
finding peers. A state other than ready is main's answer to this ask, never an earlier one.

**IPFS reads the node first, and never waits on it.** When `HostConfig.ipfsNode` is set, `startIpfs` builds two
gatherers over the same protocol, one over the node's endpoint and one over `gateways`
([`../ipfs/node-first.ts`](../ipfs/node-first.ts)). A mount asks the link for the node: ready, it reads only the
node; off, failed or still starting, it reads the gateways and the mounted site says why (`servedFrom`). A name
service is still asked for an IPNS record after the node, unless the lookup service is off. Each read from the node
carries the key of the mount's partition (`partition-key.ts`; header `x-orivon-partition`) and no other source sees it. A block the node could not give is asked for again after the node's own memory of it has passed (`../ipfs/README.md`); a test build can name a fixture endpoint as the node and shorten that wait (`HostConfig.ipfsNode.retryWaitMs`).

**A tunnel-profile website is served from a second set of protocols** ([`tunnel-protocols.ts`](tunnel-protocols.ts), routed by `x-orivon-route: tunnel`, which main sets on every request of the tunnel profile's session and strips from every other). Every fetch that set makes is [`routed-fetch.ts`](routed-fetch.ts)'s: HTTP over TLS over a `CONNECT` to the tunnel profile's front (`HostConfig.profileFront`), which opens the stream through the tunnel with the name unresolved. IPFS is read through gateways only, never the local node, and DNSLink, IPNS name services and CCIP-Read go the same way; the name is proved by a second light client (`light-client/README.md`) started at the first such `.eth` name. A Swarm address, or a name whose content is on Swarm, is refused with `SWARM_NOT_TUNNELLED`'s sentence, because the Swarm node dials its peers itself. `Sites` keeps one set of mounts per route (`RoutedSites`), so a name proved through the tunnel is never served to a direct website; the IPNS sequence and Swarm feed index stores are shared, since they only move forward. The set reads through gateways whatever the person chose for IPFS, and asks a name service for an IPNS record whether or not the lookup service is allowed: that setting and the choice of the node are about the node, which such a website never uses.

**Owner stream.** `ens-ipfs`.

## Design notes

**Every request leaves through [`egress.ts`](egress.ts), over Electron's `net`, except a CCIP-Read
request when no proxy is configured, and the DNS-tamper fallback below.** A configured proxy
applies to everything else. A CCIP-Read URL, which a name's resolver contract chooses, is checked
the same way either way (https, port 443, every address public unicast), but only dialled through
[`direct-fetch.ts`](direct-fetch.ts) at the address `resolveHost` already checked -- closing the
rebind window a second, unpinned resolution would otherwise leave (`net` cannot pin a request to
an address a check already resolved, confirmed against Electron 44's API, the same gap
`open-questions.md`'s A66 names for a different caller) -- when `HostConfig.ccipDirect` says main
found no proxy in front of the default session. With one configured, the request goes back through
`net` by hostname instead: a proxy must keep doing the resolving, never be silently gone around for
one kind of request (T20), so the residual rebind window is accepted there rather than closed by
bypassing it. **While the whole browser is on the tunnel** (`HostConfig.front`) the host fetches with `net.request` and answers
the front's proxy challenge itself, for that front's address and port alone ([`front-login.ts`](front-login.ts)), because `net.fetch` in a utility process raises no
`login` event and would end at the front's `407`; main points the process's own requests at the front with `app.setProxy`, a name is
never resolved on this computer (`resolveHost` refuses, and a CCIP-Read check resolves nothing, the far end does), and `unproxiedGateways` and `ccipDirect` are empty and false, so
none of the host's direct routes is taken. Main restarts the host when the setting flips. `ccipDirect` is a snapshot taken once, when the host starts
(`main/verifier/verifier-subsystem.ts`'s `ccipDirectFor`, checked against a generic URL since a
CCIP-Read destination is not known yet); a proxy turned on mid-run is not seen until the host
restarts, the same shape as `security-model.md` T40's own snapshot. The one OTHER path around
`net` is [`dns-fallback.ts`](dns-fallback.ts), only for a gateway that had no proxy configured when
the host started (ADR-0030's 2026-09-26 amendment); taking it for a proxied gateway would silently
bypass that proxy, and the check being a snapshot is T40's residual there too.

**What the host waits for is longer through a tunnel, and the shared light client starts late.** [`pace.ts`](pace.ts) holds two sets of waits: with no tunnel a `.eth` load waits 8 s for the light client's first sync and a name's proof is given 25 s; when the whole browser is on the tunnel (`config.front`) or the website is in the tunnel profile it is 60 s and 100 s, measured against a Nym tunnel (a cold tunnel and the sync took 25 to 45 s). With the whole browser on the tunnel the shared light client does not sync when the host starts but when a `.eth` name first asks, or three minutes later, whichever comes first: the sync fetches about two megabytes, which a mixnet carries in two minutes, and every other request through the tunnel crawls meanwhile, an `ipfs://` page included. The three minutes keep the checkpoint renewal that a host started for it (`../../main/verifier/README.md`) relies on. The IPFS block limits are the same for both: a block wait of 60 s made a stalled gateway cost 60 s, and the loads measured were no faster.

**The routed fetch speaks to the profile's front, not to the tunnel's SOCKS5 address.** [`routed-fetch.ts`](routed-fetch.ts) sends a `CONNECT` with the front's sign-in and then runs TLS over the stream, with Node's own sockets, because `net.fetch` in a utility process cannot sign in to a front (it ends at the `407`). The front is the one place that already waits for Nym to start, follows a changed tunnel and fails closed with nothing direct, and Nym's port changes at every start, so the host would otherwise have to ask main for an address at each connection. Connections are kept alive and pooled per destination, since a Nym stream is slow to open. It follows no redirect (a 3xx comes back as a response and `allowlisted` refuses it), carries no cookie and no cache, and takes plain HTTP only in a test build's fixture.
