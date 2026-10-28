# `src/main/verifier/`: the shell's side of the verifier

**What lives here.** What the main process does for every host a protocol serves (`.eth` names,
`ipfs://` addresses): the resolver rules that send them to the verifier's loopback port, the
certificate check each session applies, starting and restarting the verifier host (and what a request waits for until it listens)
([`../../protocols/verifier-host/`](../../protocols/verifier-host/)), the light client's
checkpoint ([`ADR-0031`](../../../docs/decisions/ADR-0031-helios-is-the-light-client.md)) and its renewal at run time from two beacon servers that agree ([`ADR-0092`](../../../docs/decisions/ADR-0092-when-no-checkpoint-is-recent-enough-two-beacon-servers-that-agree-supply-one.md)), what the
host verified between runs (IPNS sequences, Swarm feed indexes, and the address scheme each `.eth` name's content was last found under), the per-site partition stamp, the gateway proxy check, and the
wording of the status and a name's evidence for Settings and the site-info popover, and the light client's failures and syncs as lines of the main process's log, where a bug report finds them.
Which Ethereum servers the light client asks is decided here: Orivon's ([`endpoints.ts`](endpoints.ts)), or the ones the person named in Settings > Web3 ([`eth-servers.ts`](eth-servers.ts) reads the three settings; [`eth-servers-source.ts`](eth-servers-source.ts) remembers what the running host was started with, so only a change to the servers restarts it; [`light-client-config.ts`](light-client-config.ts) builds the light client's part of the host's configuration from them, and the one log line that says the person's servers are asked).
The person can switch the light client off in Settings or from the Available networks popup (`web3.lightClient`, read at each
start of the host through `configureVerifier` and applied at once: see below); the environment switch still forces it off
(`lightClientForcedOff`, the one place that reads it), and
[`web3-domain.ts`](web3-domain.ts) is what the Settings page reads.

**Tied to Electron.** [`verifier-subsystem.ts`](verifier-subsystem.ts),
[`local-node-launch.ts`](local-node-launch.ts) and [`checkpoint-fetch-net.ts`](checkpoint-fetch-net.ts) are the files that
import `electron`; the rest are `<name>.ts` decisions ([`../README.md`](../README.md)).

**What it depends on.** [`../../protocols/`](../../protocols/) (`verifier-host/protocol.ts`,
`builtin.ts`, `resolution/`), [`../dev/eth-resolver.ts`](../dev/eth-resolver.ts),
[`../../broker/`](../../broker/) (`grants/node-ledger-storage.ts`'s atomic write,
`policy/pin.ts`), [`../../loader/fetch/`](../../loader/fetch/) (`verifier-origin.ts`,
`content-root.ts`), [`../../trust/website-level.ts`](../../trust/website-level.ts),
[`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts), [`../auth/note-certificate.ts`](../auth/note-certificate.ts) (told which certificate each connection presented, from the verify proc), the top-level
`registry.ts`, `node:fs`, `node:fs/promises`, `node:net`, `node:path`, and `multiformats` (`cid`,
`bases/base36`) for the same IPNS-key shape check `ipfs/ipns.ts` applies, never that file itself
(this directory's own boundary, below).

**What it must never import.** The verifier host's code, as opposed to its protocol types: it
runs in another process, and only [`host-supervisor.ts`](host-supervisor.ts) talks to it. Three files of the host are
the exception, because main and the host must apply one rule: `light-client/endpoint-mask.ts` (the mask every shown address goes
through), `light-client/server-address.ts` (what a server address may be) and `local-rpc-fetch.ts` (how a server on this
computer is reached, which `checkpoint-fetch-net.ts` uses for a beacon server of the person's that is local). They import
nothing else of the host but each other, `direct-fetch.ts` (the Node sockets and pinned lookup that `local-rpc-fetch.ts` is built
on, which imports only Node and the broker's address policy) and the types of `egress.ts`.

**Owner stream.** `ens-ipfs`.

## Design notes

**The checkpoint rule is written twice, on purpose.** [`checkpoint-fetch.ts`](checkpoint-fetch.ts) decides, from the
servers' answers, whether a fresh checkpoint may be used (every server answers, all give the same finalized head, the
checkpoint is the block at the first slot of the head's epoch, or of one of the seven before it, that the consensus
server serves a bootstrap for with a header at that slot (the others are asked for the root meanwhile and must name the
same one), the whole attempt takes at most 20 s, and the time
is within the clock's tolerance and the age limit); `scripts/refresh-eth-checkpoint.mjs`
applies the same rule when a release's checkpoint is chosen. A script cannot import the TypeScript, so
`scripts/tests/refresh-eth-checkpoint.test.ts` feeds both the same answers and compares the verdicts and the server
lists. A change to either rule is a change to both. The renewal starts as the host's configuration is built
(`verifier-subsystem.ts`'s `hostConfig`), and requests held for the host count their time to start from its end
(`listening-gate.ts`'s `hold`), so the servers' time limits are not taken out of the host's.

**A checkpoint the beacon server answers 404 to is given up at once, not when it ages out.** The light client fails with
"could not fetch bootstrap ... status: 404" when the consensus server serves no bootstrap for the root it was given, and
retries the same root for ever. The host classifies that failure where it happens (`helios-errors.ts`'s
`bootstrapMissing`) and sends it as the `bootstrapMissing` field of its failed status; `CheckpointRenewal`'s
`recoverUnserved` then holds the root `chooseForStart` recorded as not to be chosen again in this run, renews with the rule
above (within the wait after a failed attempt, that failure stands; an attempt that leaves no usable checkpoint is a failed
one) and, if the host is running and was started with another root, puts it to sleep and starts it again, so its
configuration is built with the new checkpoint. The stored checkpoint outranks the release's from then on, so the next
run starts from it.

**A `.eth` name is shown by the scheme of the protocol the host chose to load it, and as its plain origin
until then.** The host posts `name-scheme` as soon as a name's records are resolved and a gatherer is chosen
for them, before any content is fetched, and again if a fallback gatherer of another protocol takes over;
a name whose records no gatherer loads posts nothing. `VerifierStore` keeps the answer (`name-schemes.json`,
4096 names, a new answer replacing the old, least recently touched dropped first), `verifier-subsystem.ts`
hands the lookup to `BUILTIN_ADDRESSES.learnSchemes` once at launch, and a changed answer is announced
(`onNameSchemeChange`, in [`name-scheme-events.ts`](name-scheme-events.ts), apart from the subsystem so a
screen can listen without importing Electron). Every window pushes its state again, and the loading screen
words itself again, so an address follows a name learned mid-load or moved to another network. The Settings and
permissions pages run their own copy of the address module, which learns nothing, so they show a `.eth` name as its plain origin. The list is a record of the names visited, so "Clear browsing data" empties it (`forgetNameSchemes`) with the cache and with all history.

Each file's own header covers its rule (one owner of `--host-resolver-rules`, the synchronous
port probe, `.localhost` names to IPv4 loopback so a local-pattern page cannot reach a server on `[::1]`, fingerprint-only certificates, request deadlines and backoff, the checkpoint's age).
What is here has no other home.

**The partition stamp is on every session that can reach the verifier over Chromium's own
networking, never on one an installed app's own content intercepts.** On the default session it
is `installPartitionStamp`, registered through
[`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts), LAST among that session's
`onBeforeSendHeaders` handlers so nothing earlier, an extension rule included, can set or remove
the header underneath it. A `webRequest` listener sends its session's requests through Electron's
proxy, and then a redirect a `protocol.handle` handler returns reaches the page with the
redirect's status (`test/app-loading/e2e-served-csp.test.ts` measures it): a cache-served app's own partition
serves its `https` through such a handler (`src/loader/electron/serve.ts`'s `registerAppOrigin`,
for the WHOLE scheme, not only the app's own host), and so does a web context, so a listener there
would break every routed redirect; a request that handler does not itself serve, a third-party
fetch a page inside it makes, is dialled by `src/loader/reach/reach.ts`'s own Node-level `https`,
which cannot resolve a `.eth` name either, so that partition never needs the stamp. An embed guest
(`<webview>`, `persist:embed-` sessions) has no such handler: it shows another site's real
document over Chromium's ordinary networking, so it reaches the verifier exactly as a tab does,
and `src/main/embed/embed-host.ts`'s `configureEmbedSession` installs the identical stamp there,
reusing `partition.ts` rather than copying it.

**The same handler marks the requests of a website in a tunnel's profile.** `installPartitionStamp` is told by `website-sessions.ts` which tunnel a session is the profile of, if any, and sets `x-orivon-route: nym` or `socks5` on every request that session makes to the verifier, or strips the header on every other session (the embed's included), so a page cannot choose a route. The host serves a marked request from protocols that fetch only through that tunnel's profile front (`protocols/verifier-host/README.md`). Main asks the host about a website in a profile with the same mark in its mount and provenance requests (`routeOf`), and hands it the front of each tunnel's profile when it starts (`host-proxy.ts`).

**The host runs only while `.eth` or an address is in use.** [`host-lifecycle.ts`](host-lifecycle.ts) starts it on the
first request to a host the verifier serves, or when the address bar's text names one
([`verifier-access.ts`](verifier-access.ts)'s `prewarmVerifier`, called from the omnibox), and puts it to sleep through
`HostSupervisor.idle()` once no tab shows a verifier-served origin
([`tab-on-verified-origin.ts`](tab-on-verified-origin.ts); an installed app served from its pin does not count) and nothing has asked for it for ten minutes. `idle()` is not
`stop()`: it counts as no crash, shows no failure, restarts nothing, and a later `start()` forks a fresh process after the
old one has exited. The light client refreshes the stored checkpoint only while it runs, and refuses one older than
fourteen days, so two minutes after launch a newest checkpoint older than seven days starts the host once; the idle wait
ends that run. With the light client switched off, or in a private session, whose checkpoint is thrown away at its
end, nothing starts at launch. The partition stamp and the listening gate
stay registered on the default session whatever the host is doing: they are also what keeps `net.fetch` from crashing a
session that holds an extension's network permission ([`../extensions/README.md`](../extensions/README.md)).

**A request to a host the verifier serves waits until the host listens.** The host forks, reads its config and binds, so a
request that finds it asleep would reach a closed port and leave the tab on the connection-refused page, for good.
[`listening-gate.ts`](listening-gate.ts) is the wait: an `onBeforeRequest` handler on the default
session starts the host at once if it is not running, then holds the request until the host
listens, reports it cannot serve, or `LISTEN_WAIT_MS` passes. The bound is about three times the
slowest start measured, so a host that never answers still ends in the ordinary error. A restart
and a wake after sleep hold requests again. `verifierContentAddress` waits the same way for a cache-served origin. An
embed guest's session starts the host and waits for it from its own handler
([`../embed/embed-host.ts`](../embed/embed-host.ts)).

**The first request to a host connects alone, and the rest wait for its TLS session.** Chromium verifies the run's
self-signed certificate on every full handshake. Of several connections opened at once to a host with no TLS session
yet, a handshake that starts after the first one's verification job ended and before the shell's verify proc answered
for it is refused with `ERR_CERT_AUTHORITY_INVALID`, and the proc is never asked about that socket (a net log shows
the refused socket bound to no verification job, its siblings accepted). A page that pulls a stylesheet, images and
fetches from a `.eth` name no tab has opened therefore loses some of them, at random. A resumed handshake is not
verified, so [`first-contact.ts`](first-contact.ts) (wired to each session by [`first-contact-sessions.ts`](first-contact-sessions.ts)) lets the first request to each host go on and holds the others,
in the listening gate's handler, until the certificate has been accepted (plus `SESSION_KEPT_MS`, for the server's
session ticket to arrive), the first response begins, or three seconds pass. After that the host goes unheld for two
minutes, less than the verifier's 300 s session lifetime. The state is per session, because Chromium keeps TLS
sessions per session, and each start of the host process forgets it, because the new certificate invalidates every
kept session. An embed guest's session is not covered. Making Chromium accept the certificate itself (an
`--ignore-certificate-errors-spki-list` entry for the run's key, which main would have to generate and hand to the
host) would end the race for good, and is a change to the certificate check.

**The certificate check goes on every session, through `session-created`.** A partition without
it cannot load any host the verifier serves.

**The proxy check runs in main, not in the host** ([`proxy-check.ts`](proxy-check.ts), asked by [`host-proxy.ts`](host-proxy.ts), which also hands the host the tunnel's front while the whole browser is on the tunnel, and the tunnel profile's front for the fetches of a website in that profile). It needs
`app.resolveProxy`, and a `utilityProcess` has no `session` to ask. It runs once per host start,
per gateway, since a PAC script can answer differently per URL.

**`verifierServesName` says whether a `.eth` name would load in this run.** [`verifier-access.ts`](verifier-access.ts) answers it
from what `verifier-subsystem.ts` provides: true for a developer-mode name, a test-build fixture, or while the light client can
start from a usable checkpoint; false with the light client off or unable to start, and before anything has provided it. A
feature that sends a person to a `.eth` name, such as [`../shell/eth-gateway-rule.ts`](../shell/eth-gateway-rule.ts), asks it
first, so it never replaces an address that works with one that cannot load.

**A local node runs on demand, beside the verifier host and under the same idle rule.** There are two kinds, the
Swarm node and the IPFS node: [`local-node-controller.ts`](local-node-controller.ts) starts one when a mount asks
for it (`node-wanted`, by the node's name; [`local-node-subsystem.ts`](local-node-subsystem.ts) is the shared
asking, state and endpoint, and [`swarm-node-subsystem.ts`](swarm-node-subsystem.ts) and
[`ipfs-node-subsystem.ts`](ipfs-node-subsystem.ts) say which kind each is and when a test build serves its content
otherwise; [`local-node-launch.ts`](local-node-launch.ts) holds what every node needs of Electron, and is the file there that
imports `electron`), waits at most twenty seconds for the node to be ready (the Swarm node: eight peers; the IPFS node: its health answers), and answers `ready`, `starting`,
`failed` or `off` with the reason in words. It sleeps when the verifier host does and after ten
minutes with no call, so a call must be made for every mount, not only one that finds no node ready. It does
not start when a proxy the system itself sets is configured (the node's sockets would go around it, T20); with the whole
browser on the tunnel AND "Use tunnel to run network nodes" (`network.tunnel.nodes`, default off) on it
starts through the tunnel instead (`NodeRoute`: the controller asks the tunnel for the node's address before it forks, hands it
over on the node's `route-ask`, and tells the node when the address stops being right), is switched to the other path by
`tunnelDefaultChanged` the moment either setting flips, and is off with the tunnel's reason when the
tunnel cannot carry it
([`ADR-0086`](../../../docs/decisions/ADR-0086-the-local-nodes-run-through-the-tunnel-while-the-whole-browser-does.md),
[`ADR-0087`](../../../docs/decisions/ADR-0087-the-nodes-follow-the-tunnel-only-when-the-person-asks-and-no-gateway-is-read-without-the-persons-yes.md)).
With the setting off a node runs direct beside the whole-browser tunnel, and the proxy question goes to the session that follows the system
alone (`systemProxyFor`), because the default session answers with the tunnel's own front. [`node-route.ts`](node-route.ts) holds the
three answers the rest asks (`nodesRunThroughTunnel`, `nodesMayServeTunnelSites`, `nodesFollowTunnel`); `hostConfig` hands the host
`tunnelSitesReadNodes` and `ethereumOutside` from them. The Ethereum light client follows the same setting: outside the tunnel when it
is off, unless the system sets a proxy of its own. It does not start either when its files are
missing or are not the ones the build pins ([`local-node-artifact.ts`](local-node-artifact.ts), checked once for
each start, a restart included, with the proxy looked at first so nothing is read while one is set; the process
then hashes the bytes it runs itself), or in a build that serves its content from its own endpoints. Both processes are
kept by [`process-supervisor.ts`](process-supervisor.ts): forking, the config handed over, backoff, sleep.
[`host-supervisor.ts`](host-supervisor.ts) adds the verifier host's requests and replies,
[`local-node-supervisor.ts`](local-node-supervisor.ts) a node's reports.

**Where IPFS is read from applies at once.** `ipfsSettingsChanged` stops the IPFS node when `web3.ipfsSource` or
`web3.ipfsLookupService` changes, and its next start reads the routing mode again (the controller's `options`).
Only a change of the source also puts the verifier host to sleep, whose next wake builds `HostConfig` from it (the
lookup service touches only the node's arguments, so the light client, the mounted sites and the Swarm node are
left alone): `ipfsNode` (the node's endpoint) is present only when the person chose the node, and never in a test
build. The host reads from the node; when the node cannot serve a page it fails with the reason and an offer of public gateways, which
the person accepts for one load, and the page then says which served it; Settings'
`ipfsNode` view and the site-info popover's "Loaded from" row repeat it. With the person's standing choice of gateways, no node
is built at all. The lookup service does not restart the
host: the running host is sent `ipfs-lookup` and asks a name service for an IPNS record only while it is allowed.
`forgetNodeData` (clearing cached data or all history) stops the node, deletes its database once the process has
exited, replaces the partition salt (`verifier-store.ts`), puts the verifier host to sleep and, once its process has exited (ten
seconds at most), deletes the Swarm chunk files the host keeps (`forget-node-data.ts`) except those of the salt in force then, which a host
started meanwhile may hold open. Every step is tried even when an earlier one failed, and the first failure is reported at the end.

**The light client, the Swarm node and the process facts apply at once or are read live.** `lightClientSettingChanged` puts the
verifier host to sleep when `web3.lightClient` changes, so its next start builds the config from the new choice; the person's
setting is read at each start (`configureVerifier`), and the environment's force-off still wins. A host that sleeps stops the IPFS
and Swarm nodes with it, as it does after ten idle minutes, and each starts again at the next ask. `swarmSettingChanged` makes the
Swarm node's controller read its `disabled` hook again (`LocalNodeController.reconsider`, which also drops a check under way and
reads the switch again once one ends) and puts the host to sleep too, so nothing mounted from Swarm outlives a switch-off: a node
that must not run is stopped and says why (`SWARM_SWITCHED_OFF`, which also names where to switch it on, and which a bzz:// page
repeats), and one that may run again is asked for as usual, with no refusal remembered. Every supervisor can say its running process (`processInfo`: the
process id and when it was forked), which `../networks/` matches to Electron's metrics. The verifier host counts what it reads from
each node (`node-traffic.ts` in `protocols/verifier-host/`) and posts it at most once a second while the node is read; main keeps
the last figures and folds a host's bytes into the session's total when the host sleeps (`nodeTraffic`).

**[`kept-provenance.ts`](kept-provenance.ts) keeps what the verifier last proved about a site, so a failure to look is not read as evidence.**
`verifierNameEvidence` asks the host for the site's mount; the host forgets a mount ten minutes after it was proved,
whenever it sleeps or restarts (an idle host, a tunnel or IPFS-source change, a light-client or Swarm switch, a crash), and a failed re-proof (offline, a
tunnel down) does not renew it. Without a mount the evidence has no content and the Website level reads 1, so a site that
was Level 2 or judged 4 would turn red and Web2 for being offline. The last provenance per site and route is shown instead,
with the age of that check and a row saying it could not be repeated. Evidence against a site always arrives as a fresh
provenance (a file that failed its check, another content root), which replaces the kept one. Clearing site data, the
cache or all history forgets them (`forgetKeptProvenance`).

**A page that is not whole says so** ([`failed-files.ts`](failed-files.ts), [`failed-files-store.ts`](failed-files-store.ts), `partition-stamp.ts`'s `installFileFailureWatch`, [`ADR-0088`](../../../docs/decisions/ADR-0088-every-wait-on-the-load-path-comes-from-the-route-it-travels.md)). Chromium stops a tab's loading indicator when every request has ended, whether or not each was answered, so a stylesheet the verifier could not read (a `5xx`) leaves a page with text and no colours that looks finished. Each website session notes, per tab, the files (not a document or a frame; a `404` is a file the site lacks) answered with a failure, forgets one when the same address later arrives and all of them when the tab loads another document, and the shell state's `filesFailed` count shows the address bar's mark. Only pages the verifier serves are watched.

**The person's servers replace Orivon's field by field, and nothing falls back.** A custom choice with an empty field keeps
Orivon's for that field (`eth-servers.ts`'s `effectiveEthServers`). The checkpoint renewal still asks Orivon's two beacon
servers for the finalized head and for each block root, so a block that only the person's server vouches for is never used;
the person's beacon server is asked for the block root at the slot and for the bootstrap (`CheckpointRenewal`'s
`consensusRpc`), and the roots recorded as unserved are forgotten when that server changes. The status page says what to
do about a failure (`status-view.ts`'s `OWN_FAILED`, never an address) only when the host puts the failure on the
person's servers (the `ownServersFailed` field of its failed status: every execution server they named is in trouble or
none is mainnet, or their beacon server did not give the bootstrap). A clock that is behind, one of Orivon's servers
failing beside a server of theirs, and a failure the host cannot place get the reason alone. A change to the servers
puts a running host to sleep only while the light client is on, since a host started without one holds no servers
(`verifier-subsystem.ts`'s `ethServersChanged`).
