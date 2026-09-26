# `src/verifier-host/`: the process that serves `.eth` names

**What lives here.** The verifier host: an Electron utility process that proves `.eth` names with a
light client, gathers their IPFS content block by verified block, and serves it to tabs over a
loopback TLS server. Every untrusted parser (the light client's WebAssembly, CCIP-Read answers,
IPNS protobuf, dag-pb, DNS-over-HTTPS JSON) runs here, never in the main process.
[`ADR-0030`](../../docs/decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md) is the
design; [`ADR-0031`](../../docs/decisions/ADR-0031-helios-is-the-light-client.md) admits Helios.

**Tied to Electron.** Disposable. [`entry.ts`](entry.ts) is the utility-process entry and the one
file that imports `electron`; [`service.ts`](service.ts) takes Electron's `net` and the parent port
as arguments, so everything else runs under plain vitest.

**What it depends on.** [`../resolution/`](../resolution/), [`../ens/`](../ens/),
[`../ipfs/`](../ipfs/); from [`../loader/`](../loader/) the range parser, the content-type map and
the redirect rule, and from [`../broker/policy/`](../broker/policy/) the address classifier, all
reused rather than copied; `@a16z/helios`.

**What it must never import.** [`src/main/`](../main/) beyond type-only imports: main starts it and
talks to it over [`protocol.ts`](protocol.ts), and nothing else. [`../main/verifier/`](../main/verifier/)
is its other side.

**Owner stream.** `ens-ipfs`.

| Folder | Holds |
|---|---|
| (top level) | `entry.ts` (the utility-process entry, a build input), `service.ts`, `protocol.ts`, `egress.ts`, `doh.ts`, `direct-fetch.ts`, `dns-fallback.ts`, `fixture-resolver.ts` |
| [`light-client/`](light-client/) | Proving a `.eth` name: Helios and its wrappers |
| [`serve/`](serve/) | The loopback TLS server, its certificate and per-name mount cache |

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment warns about a trap a maintainer would otherwise fall into, and the argument for
a design belongs here instead.

**Why `light-client/` and `serve/` are each their own folder.** See
[`light-client/README.md`](light-client/README.md) and [`serve/README.md`](serve/README.md) for
what belongs to each and why it is shaped the way it is; this file covers only what is common to
the whole directory, or belongs to a top-level file.

**Every request leaves through [`egress.ts`](egress.ts), and through Electron's `net` --
with one narrow, gated exception.** Fixed endpoints (the light client's RPCs and beacon API, the
gateways, the DNS-over-HTTPS resolvers) each get an origin allowlist that follows no redirect. A
CCIP-Read URL is chosen by a name's resolver contract, so it gets the guard the loader's install
fetch has: https only, every address the name resolves to public unicast, redirects only within
the origin, and a size and time cap. Electron's `net` cannot pin a request to the address that was
checked, so a name that re-resolves between the check and the request is a residual window, the
same one `open-questions.md` A66 names for the loader. Going through `net` rather than Node's own
`fetch` is what makes a configured proxy apply -- which is exactly why [`dns-fallback.ts`](dns-fallback.ts)
never reaches [`direct-fetch.ts`](direct-fetch.ts) for a gateway with a proxy configured: bypassing
`net` there would silently bypass that proxy too. The exception exists only for a gateway `net`
has just failed with a transport error and a DNS-over-HTTPS answer disagrees with the system
resolver's (`open-questions.md` A251, `ADR-0030`) -- `direct-fetch.ts`
connects to a pinned address over `node:https` with TLS still checked against the real hostname,
since neither of Electron's `net.fetch`/`net.request` can pin a connection while keeping the real
hostname for SNI.

**Fixture names exist only in a test build** ([`fixture-resolver.ts`](fixture-resolver.ts)). The
shell sends them only when the dev-grant flag is compiled in, and [`entry.ts`](entry.ts) refuses
them otherwise. A name the fixture resolver does not hold is `unavailable`, never `not-found`: not
holding a name proves nothing about it.
