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

**What it also depends on, for the chunk store.** `node:sqlite`, `node:fs`, `node:path` and `node:crypto`: [`swarm-chunk-database.ts`](swarm-chunk-database.ts)
is the one file here that writes the profile, and only its own `swarm-chunks-*` files.

**What it must never import.** [`src/main/`](../../main/) beyond type-only imports: main starts it
and talks to it over [`protocol.ts`](protocol.ts), and nothing else.
[`../../main/verifier/`](../../main/verifier/) is its other side. The one exception runs the other way: four leaf files here
(`light-client/endpoint-mask.ts`, `light-client/server-address.ts`, `local-rpc-fetch.ts`, `swarm-chunk-files.ts`) are imported by main, and the first two by the
Settings page, because each holds a rule main and the host must apply alike.

**A local node is asked for as each mount that reads from it begins.** [`node-link.ts`](node-link.ts) serves any
kind of node by its name (`NodeLinks.to`). When `HostConfig.swarmNode` is set, the Swarm endpoint is the node
Orivon runs ([`../swarm-node/`](../swarm-node/)): the link posts `node-wanted` to main on every mount (which
keeps the node's ten-minute idle wait from running out under use). A state other than ready is main's answer to
this ask, never an earlier one: a wait lasts up to twenty seconds for main's `node` notice, then ends `unavailable` in
plain words, off or failed with the reason, or still finding peers. A Swarm mount does not wait for that answer: its
reads wait for it only where a chunk has to come from the node, so a site whose every chunk is in memory or on disk
opens while the node is starting, slow or failed ([`../swarm/README.md`](../swarm/README.md) section Design notes). The one
exception is `HostConfig.swarmSwitchedOff`, set when the person has switched Swarm off: the Swarm gatherer then holds each mount for
the answer first, which is the refusal, so a site on disk does not open against the switch. Any other reason the node is off
(a proxy, a tunnel that cannot carry it, files that are missing) stops only a read that needs the node. The IPFS mount waits
for its node first, as it must choose between the node and gateways.

**IPFS reads the node, and a gateway only with the person's yes for this load.** When `HostConfig.ipfsNode` is set, `startIpfs` builds two
gatherers over the same protocol, one over the node's endpoint and one over `gateways`
([`../ipfs/node-first.ts`](../ipfs/node-first.ts)). A mount asks the link for the node: ready, it reads only the
node; off, failed, still starting, or ready but unable to find the content, the mount fails with `GatewaysOffered`, which the error page
([`serve/error-pages.ts`](serve/error-pages.ts)) turns into a button, "Load through public gateways". The button is a link to
`/.orivon/load-through-gateways` on the site's own origin with a token only that page was given ([`gateway-consent.ts`](gateway-consent.ts):
an HMAC of the site's origin); the server grants a yes only to a navigation the person started (`Sec-Fetch-User`) that carries the token for
the request's own partition, and redirects back to the page. The yes is for one load: the first mount in that partition takes it (`take`), it is
gone after a minute unused, and `Sites.get` does not reuse a site a yes loaded for a page load the person starts (a document navigation), so a
reload or a new tab asks again. The mounted site says why it came from gateways (`servedFrom`). With no node chosen (the person's standing choice
of gateways) `ipfsNode` is absent and the gateways serve as the person chose. A name
service is still asked for an IPNS record after the node, unless the lookup service is off. Each read from the node
carries the key of the mount's partition (`partition-key.ts`; header `x-orivon-partition`) and no other source sees it. A block the node could not give is asked for again after the node's own memory of it has passed (`../ipfs/README.md`); a test build can name a fixture endpoint as the node and shorten that wait (`HostConfig.ipfsNode.retryWaitMs`).

**A website in a tunnel's profile is served from a set of protocols of that tunnel** ([`tunnel-protocols.ts`](tunnel-protocols.ts), routed by `x-orivon-route: nym` or `socks5`, which main sets on every request of that tunnel's profile session and strips from every other; a set is started at the first request that names its tunnel, so a person who uses one tunnel pays for one). Every fetch a set makes is [`routed-fetch.ts`](routed-fetch.ts)'s: HTTP over TLS over a `CONNECT` to that tunnel profile's front (`HostConfig.profileFronts`), which opens the stream through the tunnel with the name unresolved. IPFS is read from the local node when `HostConfig.tunnelSitesReadNodes` says its traffic does not betray the site (the node is read on loopback with the host's ordinary fetch, never through the tunnel), and otherwise fails with `IPFS_NOT_TUNNELLED`'s reason and the same offer of gateways, which are then read through the tunnel; DNSLink, IPNS name services and CCIP-Read go through the tunnel. The name is proved by a light client of the tunnel's own (`light-client/README.md`) started at the first such `.eth` name, or by the shared client when `HostConfig.ethereumOutside` is set. A Swarm address, or a name whose content is on Swarm, is served by the Swarm node under the same condition as IPFS, and refused with `SWARM_NOT_TUNNELLED`'s sentence otherwise. `Sites` keeps one set of mounts per route (`RoutedSites`), so a name proved through one tunnel is never served to a direct website or to the other tunnel's; the IPNS sequence and Swarm feed index stores are shared, since they only move forward. The set follows the person's choice of IPFS source like the other (no node chosen: gateways through the tunnel), and the lookup-service setting for a node-served website.

**Owner stream.** `ens-ipfs`.

## Design notes

**Verified Swarm chunks are kept on disk here, per site, and nowhere else.** [`swarm-chunk-database.ts`](swarm-chunk-database.ts) is one
SQLite database (`node:sqlite`, no native module) at `<profile>/verifier/swarm-chunks-<id>.db`, where `<id>` is the first 16 hex
characters of sha256 of the profile's partition salt; main hands the host the directory and the salt as `HostConfig.swarmChunks`, even
when the IPFS node is off, and leaves it out when the profile cannot hold a salt. Rows are keyed by `partitionStoreKey(salt, partition)`
(`partition-key.ts`, the key the IPFS node's store uses) and the chunk address, so the file holds no origin in plain text and one site's
chunks are never another's hits; a site read through a tunnel is kept under the tunnel's name too ([`swarm-chunk-memory.ts`](swarm-chunk-memory.ts)'s
namespace), as the routes' in-memory caches are kept apart. What is kept is the content-addressed chunks, and for each feed a site
followed, the one single-owner chunk of the update it was last followed to, under its own address in the same table and with its
index in a small table of its own ([`ADR-0103`](../../../docs/decisions/ADR-0103-a-swarm-feed-site-opens-from-the-update-it-last-followed.md)):
the database hands that chunk back unchecked, and the gatherer verifies its signature again on every use. At most 256 MB of chunk bytes are kept in all, least recently used first; the file is about a sixth larger (32 KB pages hold
seven rows each, and the indexes), and its `-wal` is cut back to 8 MB after each checkpoint (`journal_size_limit`). Use is a count in
the file that goes up once for each minute of use and once at the start of a run, so a clock that is wrong cannot age rows; it lives in
a table of its own beside each row's size, and a row is marked at most once a minute, also when the memory in front answered it, so a
mark never rewrites a 4 KB row. The bytes kept and the count are worked out from that table each time the file opens, never read from a
figure an earlier run left, so a run that was cut short cannot leave either wrong.

**The disk is read one chunk at a time, and written without waiting for the disk.** A row read back is hashed against its address
again, on the host's event loop (about a millisecond and a half for 4 KB); a row that fails is deleted and the chunk fetched anew.
`BlockMemory.recall` stays the cache alone, and `recallKept` is the disk behind it ([`swarm-chunk-memory.ts`](swarm-chunk-memory.ts)):
each read waits for the one before and for a turn of the event loop of its own, and `ChunkSource.leaves` asks for every leaf of a file
that way before it fetches the rest, so a file of a thousand chunks read from disk lets every other request through between two
chunks instead of holding the host for a second and a half. Writes wait for 64 chunks or 250 ms and go in one transaction (WAL, 32 KB
pages, since a chunk row is a little over 4 KB) with `synchronous = OFF`: with `NORMAL`, the commit that crosses SQLite's
auto-checkpoint (1000 pages, 32 MB) runs the checkpoint's `fsync` inside that call, a stall of half a second every few
dozen writes (1.9 s at worst), where `OFF` keeps every commit under ten milliseconds. What `OFF` risks is a file damaged by a crash of the
computer, not of the process, and nothing here needs the file to survive that: each row is hashed on its way out, the counters are
worked out when the file opens, and a file SQLite reports as damaged is deleted and made again.

**A page load the person starts mounts a site again when a check found a newer version of it.** `Sites.get` is told which request is a
page load (`Sec-Fetch-Mode: navigate` with `Sec-Fetch-Dest: document`, which Chromium sets and a page cannot forge) and drops a mounted
site that answers `MountedSite.hasNewer`, as it does one the gateway consent names; any other request, a subresource or a frame
included, is served from the mount in hand, so a page that is open never changes version under its reader. The Swarm gatherer is the
one that sets it ([`../swarm/README.md`](../swarm/README.md)).

**Opening, remaking and sweeping.** The file is opened at the first Swarm mount with a partition. A file SQLite reports as damaged, at
open or in use, is deleted and made again, once in a run, and so is one whose `user_version` is not this code's layout number (the file
is a cache, so it is made again rather than read in a layout this code does not know); the second time the run keeps chunks in memory.
One that fails any other way (a full or locked disk) is left as it is. Either way one line is logged. The host's log says `swarm: the
chunk store opened with N bytes kept`, and how many chunks each mount, and each file of 256 KB or more, read from disk. Clearing cached
data or all history replaces the salt, puts the host to sleep and deletes the files once its process has exited, or after 10 s
(`main/verifier/forget-node-data.ts`), sparing the file of the salt in force then, or sparing none when the salt could not be replaced;
the host deletes every `swarm-chunks-*` file ([`swarm-chunk-files.ts`](swarm-chunk-files.ts)) whose id is not its own salt's as it
starts, before it opens anything, so a file main could not delete (Windows keeps an open file) goes at the next start.

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

**What the host waits for follows the route its requests travel, and the shared light client starts late on a slow one.** [`pace.ts`](pace.ts) turns a route's pace ([`../route-pace.ts`](../route-pace.ts), [`ADR-0088`](../../../docs/decisions/ADR-0088-every-wait-on-the-load-path-comes-from-the-route-it-travels.md)) into the host's own waits: a `.eth` load waits 8 s for the light client's first sync and a name's proof is given 25 s on a direct connection, and a route that is six times slower than that (the tunnel's declared profile, measured against Nym) waits six times as long, plus the time the tunnel may need to come up while it has carried nothing yet. Every other wait on the load path reads the same route: the first byte of a block, a record or a chunk, the hedge to a second source, the node's patient retries, the DNS-over-HTTPS lookup of a DNSLink, and how long a failed read of a file has before it is not read again ([`serve/retry.ts`](serve/retry.ts)). The host keeps one route for the requests every website's pages use (the tunnel's when `config.front` is set, because the whole browser is on it) and one for the tunnel profile's. With the whole browser on the tunnel the shared light client does not sync when the host starts but when a `.eth` name first asks, or three minutes later, whichever comes first: the sync fetches about two megabytes, which a mixnet carries in two minutes, and every other request through the tunnel crawls meanwhile, an `ipfs://` page included. The three minutes keep the checkpoint renewal that a host started for it (`../../main/verifier/README.md`) relies on. The shell asks the host for a mount with the longest wait the route can ever give (`mountCeilingMs`), so it never gives up before the host does.

**The Ethereum light client can leave outside the tunnel.** With `HostConfig.ethereumOutside` and the whole browser on the tunnel (`front`), `startEns` gives Helios and CCIP-Read [`outside-fetch.ts`](outside-fetch.ts)'s fetch (`HostDeps.outside`): Node sockets, through `direct-fetch.ts`, to addresses the system resolver (`dns.lookup`) returned and the fence checked, because the process's own network context is pointed at the front and `net` cannot leave it. Its pace is the direct pace. Main sets the flag from "Use tunnel to run network nodes" being off, and not while a proxy of the system's own applies.

**The routed fetch speaks to the profile's front, not to the tunnel's SOCKS5 address.** [`routed-fetch.ts`](routed-fetch.ts) sends a `CONNECT` with the front's sign-in and then runs TLS over the stream, with Node's own sockets, because `net.fetch` in a utility process cannot sign in to a front (it ends at the `407`). The front is the one place that already waits for Nym to start, follows a changed tunnel and fails closed with nothing direct, and Nym's port changes at every start, so the host would otherwise have to ask main for an address at each connection. Connections are kept alive and pooled per destination, since a Nym stream is slow to open. It follows no redirect (a 3xx comes back as a response and `allowlisted` refuses it), carries no cookie and no cache, and takes plain HTTP only in a test build's fixture.

**The host counts what it reads from a node.** [`node-traffic.ts`](node-traffic.ts) wraps each read `NodeLink.reading` makes:
the read is in flight from its start to the end of its body (or its cancel, or its failure), and every byte read is added up.
The totals go to main as `node-traffic` at most once a second, with a last report when the reads stop, so a popup that shows them
costs nothing while nobody looks. Nothing here decides anything: the figures are only what the Available networks popup says.

**A server the person runs on this computer or their home network is reached by [`local-rpc-fetch.ts`](local-rpc-fetch.ts), and by nothing else.** The Ethereum light client's servers normally leave by the lane's route (Electron's `net`, the tunnel's front, [`outside-fetch.ts`](outside-fetch.ts), or a tunnel profile's [`routed-fetch.ts`](routed-fetch.ts)), and each of those would take a request for a home-network address somewhere it should not go: `net` follows the proxy setting and sends a private address to a tunnel's front, which could reach the exit's own network, and `direct-fetch.ts` refuses every non-public address on purpose. So `HostConfig.lightClient.localEndpoints` names the servers that are local, and the lane's fetch ([`light-client/lane-fetch.ts`](light-client/lane-fetch.ts)) sends those to `HostDeps.localFetch`: Node sockets to `localhost` or a loopback or private address literal, no proxy, no tunnel, no redirect, a cap on the size and idle time of an answer. It keeps its own fence, the reverse of `direct-fetch.ts`'s, and reuses only the request client and the pinned lookup. The host re-checks that each address named local is such a literal, and that every other server is a public address or name, before it starts the client.
