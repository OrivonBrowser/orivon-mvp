# `src/protocols/verifier-host/`: the process that serves every protocol's pages

**What lives here.** The verifier host: an Electron utility process that runs every protocol's
providers ([`protocols.ts`](protocols.ts)), proves `.eth` names with a light client
([`light-client/`](light-client/)), gathers IPFS content block by verified block, and serves it to
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
[`../ipfs/`](../ipfs/); from [`../../loader/`](../../loader/) the range parser, the content-type
map and the redirect rule, and from [`../../broker/policy/`](../../broker/policy/) the address
classifier, all reused rather than copied; `@a16z/helios`.

**What it must never import.** [`src/main/`](../../main/) beyond type-only imports: main starts it
and talks to it over [`protocol.ts`](protocol.ts), and nothing else.
[`../../main/verifier/`](../../main/verifier/) is its other side.

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
bypassing it. `ccipDirect` is a snapshot taken once, when the host starts
(`main/verifier/verifier-subsystem.ts`'s `ccipDirectFor`, checked against a generic URL since a
CCIP-Read destination is not known yet); a proxy turned on mid-run is not seen until the host
restarts, the same shape as `security-model.md` T40's own snapshot. The one OTHER path around
`net` is [`dns-fallback.ts`](dns-fallback.ts), only for a gateway that had no proxy configured when
the host started (ADR-0030's 2026-09-26 amendment); taking it for a proxied gateway would silently
bypass that proxy, and the check being a snapshot is T40's residual there too.
