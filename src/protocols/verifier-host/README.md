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

**Every request leaves through [`egress.ts`](egress.ts), over Electron's `net`, except CCIP-Read
and the DNS-tamper fallback below.** A configured proxy applies to everything that does. A
CCIP-Read URL, which a name's resolver contract chooses, is dialled through
[`direct-fetch.ts`](direct-fetch.ts) at the address `resolveHost` already checked -- `net` cannot
pin a request to an address a check already resolved (confirmed against Electron 44's API, the
same gap `open-questions.md`'s A66 names for a different caller), so nothing between the check
and the request can hand it a different one (rebinding). This costs CCIP-Read a configured proxy,
the same trade [`dns-fallback.ts`](dns-fallback.ts) already makes for its own narrower case, since
pinning and `net`'s proxy support are not available together. The one OTHER path around `net` is
that file, only for a gateway that had no proxy configured when the host started (ADR-0030's
2026-09-26 amendment); taking it for a proxied gateway would silently bypass that proxy, and the
check being a snapshot is `security-model.md` T40's residual.
