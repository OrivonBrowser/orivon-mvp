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

**Every request leaves through [`egress.ts`](egress.ts), over Electron's `net`**, so a configured
proxy applies. A CCIP-Read URL, which a name's resolver contract chooses, gets the loader's install
guard, but `net` cannot pin a request to the address that was checked: a name that re-resolves in
between is a residual window (`open-questions.md` A66). The one path around `net` is
[`dns-fallback.ts`](dns-fallback.ts), only for a gateway with no proxy configured (ADR-0030's
2026-09-26 amendment); taking it for a proxied gateway would silently bypass that proxy.
