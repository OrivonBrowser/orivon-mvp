# `src/loader/serve/`: answering a request against the pinned bundle

**What lives here.** `serve.ts` (`createAppRequestHandler`, `fetchThirdParty`,
`verifiedManifestFor`), `asset.ts` (streams one asset, Range support), `path.ts` (maps a request
path to a pinned asset), `verify.ts` (re-verifies the whole tree), `range.ts` (Range header
parsing), `content-type.ts` (Content-Type from the file extension), `csp.ts` (builds the CSP
header) and `pin-coverage.ts` (per-session pin coverage counters).

**What it depends on.** [`../../contracts/`](../../contracts/), [`../cache/`](../cache/)
(`storage.ts`'s `openAsset`) and [`../leaf-hash.ts`](../leaf-hash.ts). `serve.ts` imports
[`../reach/`](../reach/) for `fetchThirdParty`'s dial; `reach/` imports only `serve.ts`'s types
back (`ReachDial`), so the value dependency runs one way, from `serve/` into `reach/`.

**What it must never import.** [`../../shim/`](../../shim/) -- see the parent README's "What it
must never import".

**Owner stream.** `loader`, build step 4.

## Design notes

**A served asset streams from disk; a request costs the bytes it sends.** The handler checks the
asset ([`../cache/storage.ts`](../cache/storage.ts)'s `openAsset`) for its size and identity, and
[`asset.ts`](asset.ts) streams the requested range in 64 KiB chunks, so neither a
64 MiB asset nor a Range request into one is ever held whole. The body opens the file only when
first read and closes it when it ends, fails or is cancelled, so a response nobody reads (or a
HEAD) holds no file open. If the file's identity changed after the headers were built, or it is
cut short while being read, the body fails rather than sending bytes the headers do not
describe; one open handle serves the whole body, so a file replaced mid-response keeps serving
the bytes it started with.

**Re-verification cost: whole-tree, once, at handler creation, not one leaf hash per request.**
[`ADR-0007`](../../../docs/decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md) requires
the cached tree be "re-verified at every load, not only at fetch," and a large bundle makes that
sentence a real cost decision, not a formality. [`verify.ts`](verify.ts) re-hashes
every pinned asset, streaming it through [`../leaf-hash.ts`](../leaf-hash.ts) so memory stays
flat, checks each leaf and the root against the pin exactly once, when
[`serve.ts`](serve.ts)'s `createAppRequestHandler` builds the handler that
[`../electron/serve.ts`](../electron/serve.ts) then registers with
`session.fromPartition(...).protocol.handle(...)`, not on every individual request that handler
later answers. Two things make this the right cost to pay, not merely the cheap one: `protocol
.handle` registrations do not survive an Electron process restart (confirmed against
`electron/electron`'s `protocol_registry.cc`: a session's handler map is process-local), so a
fresh handler, and therefore a fresh whole-tree check, is unavoidable once per app **per launch**
regardless of how many requests that launch makes; and the ADR's own phrase is "**between runs**",
which this satisfies exactly. What it does **not** catch is a file rewritten on disk mid-session,
after the handler for that origin has already been built, a narrower TOCTOU-shaped risk this
loader accepts rather than pays for on every request: a per-leaf hash on every single asset fetch
would mean re-hashing an app's whole JS bundle on every navigation and every repeated image
request, for a threat (local write access to a running browser's own profile directory, in a
window of an already-open app) that has larger consequences than a stale cached file. Provisional,
flagged rather than silently chosen, the same as
`bundle-hash.ts`'s own `MAX_ASSET_BYTES`/`MAX_BUNDLE_BYTES`.

**Why `readAsset` collapses every failure into one `undefined`, unlike `readPin`.** `readPin`'s
own doc distinguishes "never pinned" from "pinned but unreadable" because `../index.ts`'s TOFU-vs-
reconsent branch genuinely needs to tell them apart. Nothing downstream of `readAsset` needs that:
`verify.ts`'s whole-tree check denies the ENTIRE bundle the moment any one asset cannot be
confirmed present with its pinned bytes, regardless of whether the cause was a missing file, a
permissions error, or a directory where a file was expected. One contract, not two, because there
is only one caller-visible outcome.

**What a same-origin path serves: the exact pinned asset, with two entry-only exceptions.**
A pinned bundle is a fixed, hashed asset map, not a filesystem: `isValidCanonicalPath` refuses
every path ending in `/` except the bare root, so there is no directory index to design for.
[`path.ts`](path.ts)'s `resolveRequestPath` answers every request with an exact
pinned-path lookup or a denial, except two cases that both answer with the pinned entry and
never with anything unpinned. `/` maps to `manifest.entry`, and when the entry sits in a
subdirectory (`app/index.html`) `/` answers a 302 to it instead, so the document's relative URLs
resolve against its own directory (a `protocol.handle` redirect is followed like a network one,
measured). And a **navigation** to an unpinned route with no file extension (`/inbox/42`) serves
the entry, the history fallback every SPA host provides, so reloading a client-side route does
not 404; a subresource or `fetch()` for the same path is still denied, and so is a navigation to
a missing *file*. Telling a navigation apart takes Chromium's own navigation headers
(`Upgrade-Insecure-Requests` plus an `Accept` naming `text/html`): `protocol.handle` reports
every request with `mode: 'cors'`, an empty `destination` and no `Sec-Fetch-*` headers (measured,
Electron 44). A page can forge those headers on a `fetch()`, which only gets it the entry
document, a pinned asset it could request directly anyway.

**Why `verifiedManifestFor` (`serve.ts`) exists alongside `createAppRequestHandler`, sharing one
`resolveVerifiedBundle` helper rather than each re-deriving the same verification.** A158's
early-hydration seam needs the EXACT, already-verified manifest `createAppRequestHandler` itself
derives: an output, not an input, which is why `serve.ts`'s own header calls out this one
exception to "no `Manifest` argument, ever". `../electron/serve.ts`'s `registerServingFor` calls
it, then hydrates `GrantLedger` from the result, before building the handler at all, accepting a
second, bounded whole-tree re-verification per `registerServingFor` call (this directory's own
accepted per-launch cost, doubled rather than multiplied per request) instead of threading a
pre-resolved manifest through `createAppRequestHandler`'s public signature, which every test and
`../dev-serve.ts` already depend on staying `storage`+`origin`-only.

**What the served bundle's CSP admits, and why** ([`csp.ts`](csp.ts)). The header is
set on every served response (A110 rules out `onHeadersReceived`) and rebuilt from the live grants
per request.

- **`script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`.** The bundle's own code
  is pinned and hash-verified, `'unsafe-inline'` already grants the script power `'unsafe-eval'`
  adds, and the broker, not the CSP, is the security boundary. Libraries that compile code at run
  time (ajv, protobufjs, template compilers, BotGuard) and WebAssembly (a wasm crypto library)
  need these. A148 records what `'unsafe-inline'` gives up for content an app renders but did not
  author.
- **`data:` and `blob:` in `connect-src`, `img-src`, `font-src` and `media-src`; `worker-src
  'self' blob:`.** Neither scheme has any network reach: a page can only point one at bytes it
  already holds. MSE video plays from a `blob:` URL, captions and icons often arrive as `data:`,
  and bundlers start workers from `blob:` URLs.
- **`frame-src 'self' data: blob:`, and no third-party frame.** A `data:` or `blob:` frame is
  opaque-origin, gets no preload, and inherits this same policy (measured), so it can do nothing
  its parent cannot. Embedding a live third-party document is a bigger step than any subresource,
  and nothing asks for it.
- **`connect-src`: `'self'`, the local schemes, `tcp.connect`'s bare `host:port` sources, and
  `https.connect`'s scheme-qualified `https://host:port` sources.** The handler authorises a
  worker's fetch or a document's XHR against `https.connect`, so the header names that grant
  too. No `ws:`/`wss:` source is ever emitted from it.
- **A `*` host in `https.connect` emits `https:`** in the four reach directives. Every `https:`
  request that source admits reaches this app's own `protocol.handle` (it intercepts the whole
  scheme for the partition, workers included) and `fetchThirdParty` re-authorises it against the
  live grant, which still refuses loopback and private addresses: measured with a loopback server
  that a `*` grant's page could name in the header and that never saw a connection. What the
  handler cannot re-check is a native WebSocket, and `https:` does not admit `wss:` (measured,
  see [`../reach/README.md`](../reach/README.md)).
  `tcp.connect`'s `*` still contributes nothing to `connect-src` (A43).
- **No `form-action`.** It never falls back to `default-src`, so it is unrestricted. Restricting
  it to `'self'` would also refuse the redirects a form-post sign-in flow follows after the form
  leaves the app, and would bound nothing: top-level navigation is not governed by CSP at all
  (A42), so a page can send the same data with `location.href`.
