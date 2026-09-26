# `src/verifier-host/serve/`: the loopback TLS server

**What lives here.** `server.ts` (the loopback TLS server itself), `certificate.ts` (its
per-run self-signed DER certificate), `sites.ts` (the per-name mount cache) and
`error-pages.ts`.

**What it depends on.** [`../protocol.ts`](../protocol.ts), [`../egress.ts`](../egress.ts) and
[`../../loader/`](../../loader/)'s range parser, content-type map and redirect rule, reused
rather than copied.

**What it must never import.** [`../../main/`](../../main/) beyond type-only imports -- see the
parent README's "What it must never import".

**Owner stream.** `ens-ipfs`.

## Design notes

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

**A name is mounted once and kept two minutes fresh, ten minutes stale** ([`sites.ts`](sites.ts)).
A page's many requests read one root without resolving the name for each. Past two minutes, the
last proven root keeps being served -- a single background re-prove refreshes it, never blocking
the request that triggered it -- for up to ten minutes, so one re-prove hitting a transient RPC
blip does not fail the whole site the moment its TTL passes. A mount gives up after 25 seconds,
because a light client fed a lie it keeps rejecting retries for over a minute. A failed re-prove is
retried after five seconds, so a burst of requests past the TTL paces to one re-prove, not one
each; past ten minutes with nothing but failures, a request waits on a fresh mount instead of the
stale one.

**Every cache is kept per partition** ([`sites.ts`](sites.ts), [`server.ts`](server.ts)'s
`partitionOf`). A partition is the top-level page origin a request belongs to, which the shell
stamps on every page's request (`src/main/verifier/partition.ts`), the way Chromium partitions its
own HTTP cache. Without it any page could request `https://<name>.eth/` and learn from the answer's
speed whether the person had opened that name in the last two minutes. The shell strips any
partition a request set itself, because a worker's request has no frame to stamp from. Such a
request uses the name's own partition, the one its tab uses, only when Chromium marks it as
started by no page (`Sec-Fetch-Site: none`: the favicon fetch, the loader) or as the name's own
worker's (`same-origin`); no page can forge either mark. Any other is served, and neither its
mount nor its blocks are kept, so it cannot evict a partition's entries either. For the same
reason [`../entry.ts`](../entry.ts) bypasses Electron's HTTP cache.

**An install pins its root** ([`server.ts`](server.ts)). The loader names the root CID it began
with on every request of one install, and the server answers `409` once the name points elsewhere.
An unchanged root answers a matching `If-None-Match` with `304` before any file is opened, so an
update check on an unchanged name asks no gateway for anything.
