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

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment warns about a trap a maintainer would otherwise fall into, and the argument for
a design belongs here instead.

**A loopback TLS server, not `protocol.handle`** ([`server.ts`](server.ts)). Chromium reaches it
through a resolver rule, so every request that is not the page's own content keeps Chromium's own
CORS, cookie and WebSocket handling. The alternative, a handler in each `.eth` origin's partition,
would have to pass every other host through a handled response, which Electron 44 serves with no
CORS, no `Set-Cookie` and no `Origin` (`docs/planning/spike-results/ens-ipfs.md` §EI-1a). The cost
is a socket every local process can reach, which `ADR-0030` weighs.

**The certificate is DER-encoded here** ([`certificate.ts`](certificate.ts)). Chromium accepts it by
fingerprint alone, so what it needs is a valid self-signed X.509 v3 structure, which is about sixty
lines over `node:crypto`. `@peculiar/x509`, the library the plan named, needs a process-global
`reflect-metadata` polyfill for its dependency-injection container, and this is the process that
holds every untrusted parser. The tests prove what matters: Node parses the certificate, its
signature verifies, and a real TLS handshake completes.

**A small file is read whole before its first byte is sent** ([`server.ts`](server.ts)'s
`MAX_BUFFERED_BYTES`). A block that fails verification halfway through a document would otherwise
leave half a page on screen; buffered, it becomes the error page instead. A file too large to
buffer is streamed with its `Content-Length`, and the connection is cut on a failure, so Chromium
sees the response as incomplete.

**Every request leaves through [`egress.ts`](egress.ts), and through Electron's `net`.** Fixed
endpoints (the light client's RPCs and beacon API, the gateways, the DNS-over-HTTPS resolvers) each
get an origin allowlist that follows no redirect. A CCIP-Read URL is chosen by a name's resolver
contract, so it gets the guard the loader's install fetch has: https only, every address the name
resolves to public unicast, redirects only within the origin, and a size and time cap. Electron's
`net` cannot pin a request to the address that was checked, so a name that re-resolves between the
check and the request is a residual window, the same one `open-questions.md` A66 names for the
loader. Going through `net` rather than Node's own `fetch` is what makes a configured proxy apply.

**The light client needs four wrappers** ([`light-client.ts`](light-client.ts),
[`helios-errors.ts`](helios-errors.ts), [`rpc-failover.ts`](rpc-failover.ts)). A `WorkerGlobalScope`
shim, or its WebAssembly timer panics on the first failed consensus request. A URL on every
response, because Electron's `net.fetch` leaves it empty and Helios throws from inside its
WebAssembly when it parses one. Its revert text turned into `{ code: 3, data }`, or viem never sees
a CCIP-Read `OffchainLookup`. And execution RPCs tried in turn per request: one RPC per instance, as
Helios takes, fails whenever that RPC's proof window is short, and since every answer is verified,
which RPC gives it changes nothing about trust.

**A name is mounted once and kept two minutes** ([`sites.ts`](sites.ts)). A page's many requests
read one root without resolving the name for each. A mount gives up after 25 seconds, because a
light client fed a lie it keeps rejecting retries for over a minute. A failure is remembered for
five seconds, so a page's burst of requests fails once.

**An install pins its root** ([`server.ts`](server.ts)). The loader names the root CID it began
with on every request of one install, and the server answers `409` once the name points elsewhere.
An unchanged root answers a matching `If-None-Match` with `304` before any file is opened, so an
update check on an unchanged name asks no gateway for anything.

**Fixture names exist only in a test build** ([`fixture-resolver.ts`](fixture-resolver.ts)). The
shell sends them only when the dev-grant flag is compiled in, and [`entry.ts`](entry.ts) refuses
them otherwise. A name the fixture resolver does not hold is `unavailable`, never `not-found`: not
holding a name proves nothing about it.
