# `src/main/verifier/`: the shell's side of the verifier

**What lives here.** What the main process does for every host a protocol serves (`.eth` names,
`ipfs://` addresses): the resolver rules that send them to the verifier's loopback port, the
certificate check each session applies, starting and restarting the verifier host (and what a request waits for until it listens)
([`../../protocols/verifier-host/`](../../protocols/verifier-host/)), the light client's
checkpoint ([`ADR-0031`](../../../docs/decisions/ADR-0031-helios-is-the-light-client.md)), what the
host verified between runs (IPNS sequences, Swarm feed indexes, and the address scheme each `.eth` name's content was last found under), the per-site partition stamp, the gateway proxy check, and the
wording of the status and a name's evidence for Settings and the site-info popover.
The person can switch the light client off in Settings (`web3.lightClient`, read once when Orivon
starts, through `configureVerifier`, so a host that sleeps and wakes keeps that run's choice); the environment switch still forces it off, and
[`web3-domain.ts`](web3-domain.ts) is what the Settings page reads.

**Tied to Electron.** [`verifier-subsystem.ts`](verifier-subsystem.ts) is the one file that
imports `electron`; the rest are `<name>.ts` decisions ([`../README.md`](../README.md)).

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
runs in another process, and only [`host-supervisor.ts`](host-supervisor.ts) talks to it.

**Owner stream.** `ens-ipfs`.

## Design notes

**A `.eth` name is shown by the scheme the host last mounted it under.** The host posts `name-scheme`
after a mount; `VerifierStore` keeps it (`name-schemes.json`, 4096 names, a new answer replacing the
old, least recently touched dropped first), `verifier-subsystem.ts` hands the lookup to
`BUILTIN_ADDRESSES.learnSchemes` once at launch, and a changed answer tells each window to push its
state again (`onNameSchemeChange`), so an open tab's address follows a name that moved networks. The
Settings and permissions pages run their own copy of the address module and keep the default scheme. The list is a record of the names visited, so "Clear browsing data" empties it (`forgetNameSchemes`) with the cache and with all history.

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

**The certificate check goes on every session, through `session-created`.** A partition without
it cannot load any host the verifier serves.

**The proxy check runs in main, not in the host** ([`proxy-check.ts`](proxy-check.ts)). It needs
`app.resolveProxy`, and a `utilityProcess` has no `session` to ask. It runs once per host start,
per gateway, since a PAC script can answer differently per URL.

**`verifierServesName` says whether a `.eth` name would load in this run.** [`verifier-access.ts`](verifier-access.ts) answers it
from what `verifier-subsystem.ts` provides: true for a developer-mode name, a test-build fixture, or while the light client can
start from a usable checkpoint; false with the light client off or unable to start, and before anything has provided it. A
feature that sends a person to a `.eth` name, such as [`../shell/eth-gateway-rule.ts`](../shell/eth-gateway-rule.ts), asks it
first, so it never replaces an address that works with one that cannot load.

**The Swarm node runs on demand, beside the verifier host and under the same idle rule.**
[`swarm-node-controller.ts`](swarm-node-controller.ts) starts it when a Swarm mount calls `ensureSwarmNode`
([`swarm-node-subsystem.ts`](swarm-node-subsystem.ts), the one file there that imports `electron`), waits at
most twenty seconds for eight peers, and answers `ready`, `starting` (still finding peers), `failed` or `off`
with the reason in words. It sleeps when the verifier host does (`swarmNodeVerifierIdle`) and after ten
minutes with no call, so a call must be made for every mount, not only one that finds no node ready. It does
not start when a system proxy is configured (the node's sockets would go around it, T20), when its files are
missing or are not the ones the build pins ([`swarm-node-artifact.ts`](swarm-node-artifact.ts), checked once for
each start, a restart included, with the proxy looked at first so nothing is read while one is set; the process
then hashes the bytes it runs itself), or in a build that serves Swarm from its own endpoints. Both processes are
kept by [`process-supervisor.ts`](process-supervisor.ts): forking, the config handed over, backoff, sleep.
[`host-supervisor.ts`](host-supervisor.ts) adds the verifier host's requests and replies,
[`swarm-node-supervisor.ts`](swarm-node-supervisor.ts) the node's reports.
