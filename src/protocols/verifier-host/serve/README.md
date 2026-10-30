# `src/protocols/verifier-host/serve/`: the loopback TLS server

**What lives here.** [`server.ts`](server.ts), the loopback TLS server that answers every host a
protocol serves (a `.eth` name, `<name>.<scheme>.orivon`, and each scheme's endpoint
`<scheme>.orivon`); its per-run self-signed certificate ([`certificate.ts`](certificate.ts)); the
per-host mount cache ([`sites.ts`](sites.ts)); [`buffer-budget.ts`](buffer-budget.ts), the bytes it holds whole before sending them; [`retry.ts`](retry.ts), which reads a file again before the page is told it is missing; [`route-of.ts`](route-of.ts), which says which route a request travels (the tunnel the shell marked it with, or direct) and how patient it is; [`error-pages.ts`](error-pages.ts); and [`gateway-offer.ts`](gateway-offer.ts), which decides when an error page offers "Load through public gateways" and what following that link does (`../gateway-consent.ts` holds the yes, for one load).

**What it depends on.** [`../../registry.ts`](../../registry.ts) and
[`../../address.ts`](../../address.ts), [`../protocol.ts`](../protocol.ts),
[`../egress.ts`](../egress.ts) and [`../../../loader/`](../../../loader/)'s range parser,
content-type map, redirect rule and leaf function (`leaf-hash.ts`, with `fetch/content-root.ts`'s header names), and
[`../../../broker/policy/`](../../../broker/policy/)'s canonical path, leaf pattern and largest file size (`MAX_ASSET_BYTES`), reused rather than copied.

**What it must never import.** [`../../../main/`](../../../main/) beyond type-only imports, as the
parent README says.

**Owner stream.** `ens-ipfs`.

## Design notes

Why a loopback server and not `protocol.handle`, why every cache is kept per partition, how long a
name stays mounted, and why an install pins its root:
[`ADR-0030`](../../../../docs/decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md)
section Alternatives considered and its two amendments. Each limit is explained where it is defined.

**The certificate is DER-encoded here** ([`certificate.ts`](certificate.ts)), about sixty lines
over `node:crypto`; Chromium accepts it by fingerprint alone. `@peculiar/x509` would need a
process-global `reflect-metadata` polyfill, in the process that holds every untrusted parser.

**A request may name the leaf it expects, and then the file is checked before a byte is sent**
([`leaf-check.ts`](leaf-check.ts), [`ADR-0075`](../../../../docs/decisions/ADR-0075-a-published-app-is-let-in-when-allowed-and-each-file-is-checked-as-it-is-served.md)).
The server buffers that one file (taking room, as its bytes arrive, in the same budget the small-file path uses), hashes it with the loader's leaf function
under the request's canonical path and sends it only if the leaf matches, cutting a range from the buffered file. The expected leaf is on the request
and nothing is kept in the host, so a restart or a sleep loses nothing. A mismatch is a `502` with `x-orivon-failure: ddoc-mismatch`.

**Only the oldest read of a site can be refused for lack of room in the buffer budget** ([`buffer-budget.ts`](buffer-budget.ts)). A file
is held whole as its bytes arrive, so several large files read together can each hold part of the site's budget and wait for room that only a
finished file frees. Each site keeps its reads in a line, oldest first. The oldest takes its chunks past the site's limit, up to the limit plus
the largest file an app may carry (a larger file cannot be a declared one, and is answered as a mismatch without being read), though never past
the backstop every site shares; it finishes and gives its share back, and the next becomes the oldest. A read leaves the line once its file is
gathered, since that ceiling already bounds what a page that never reads can hold. A later read has no limit of its own: it waits for room or
for its turn, so a slow source of the oldest read never costs it its file. The oldest read is refused (`503`, logged) only when nothing in the
budget has moved for `LEAF_CHECK_WAIT_MS`, and a read whose client left stops waiting at once.

**A failure page for a failure that may pass offers Try again, and a person's own request for the page really tries again.** The
unavailable and not-synced pages ([`error-pages.ts`](error-pages.ts)) carry a link to their own address, styled as a button, because the pages run
no script. `sites.ts` remembers a failed mount for `FAILURE_TTL_MS` so that a failed page's own requests do not each start the mount; a navigation
(`sec-fetch-mode: navigate` with `sec-fetch-dest` document, iframe or frame: the click, a reload, a typed address, a frame's own load) skips that memory and starts
the mount again, joining one still running, so a page of frames starts one. A subresource keeps the memory.

**A file of a page that nothing answered for is read again, twice, before the page gets an error page** ([`retry.ts`](retry.ts), [`ADR-0088`](../../../../docs/decisions/ADR-0088-every-wait-on-the-load-path-comes-from-the-route-it-travels.md)). A stylesheet that is answered `502` is a page without its colours that the browser still counts as loaded, so the read is made again from the blocks already held, after a short pause, whenever it failed because no source answered (`unavailable`). A missing path, bytes that failed their check and a format this build cannot read are not read again: they would fail the same way. The page's own document is not read again (its error page offers Try again, and a person's own request starts anew), nor is an install's read (a request that names the root it expects), which has its own Try again. Nor is a read again once the reads so far have taken the route's patience (30 s on a direct connection, stretched), since the layers below were patient already. A buffered file's reservation waits for room per chunk, not from the start of the request, since on a slow route chunks arrive minutes apart.
