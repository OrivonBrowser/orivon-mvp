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

**What it must never import.** [`../../shim/`](../../shim/), as the parent README says.

## Design notes

`readAsset`'s single failure value, `verifiedManifestFor`'s second verification, and which
pinned asset a path answers to (the root, a subdirectory entry, the history fallback for a
navigation) are documented on `../cache/storage.ts`'s `readAsset`, `serve.ts` and `path.ts`.

**A served asset streams from disk; a request costs the bytes it sends.** [`asset.ts`](asset.ts)
streams the requested range in 64 KiB chunks, opening the file only when first read, so neither
a 64 MiB asset nor a Range request into one is held whole, and a HEAD holds no file open. One
open handle serves the whole body, so a file replaced mid-response keeps serving the bytes it
started with; a file whose identity changed after the headers were built, or that is cut short,
fails the body rather than send bytes the headers do not describe.

**Re-verification cost: whole-tree, once, at handler creation, not one leaf hash per request.**
[`ADR-0007`](../../../docs/decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md)
requires the tree be re-verified "between runs". A `protocol.handle` registration does not
survive a restart (`protocol_registry.cc`: a session's handler map is process-local), so one
whole-tree check per app per launch is unavoidable anyway, and it meets that phrase exactly. A
file rewritten on disk mid-session is not caught: hashing per request would re-hash an app's
whole JS bundle on every navigation, against a threat (write access to a running browser's
profile) with larger consequences than a stale file. Provisional.

**What the served bundle's CSP admits, and why** ([`csp.ts`](csp.ts)). Set on every served
response (`onHeadersReceived` never fires for one, A110) and rebuilt from the live grants per
request. `csp.ts` gives the reasons for `script-src`'s eval sources and for the `data:`/`blob:`
schemes, and for leaving `'unsafe-inline'` out of `script-src`: an inline `<script>` or event
handler in an app's markup does not run, whoever wrote it.

- **`frame-src 'self' data: blob:`, and no third-party frame.** A `data:` or `blob:` frame is
  opaque-origin, gets no preload and inherits this policy (measured), so it can do nothing its
  parent cannot. A live third-party document is a bigger step than any subresource, and nothing
  asks for it.
- **`connect-src`** holds `'self'`, the local schemes, `tcp.connect`'s bare `host:port` sources
  and `https.connect`'s `https://host:port` sources, never a `ws:`/`wss:` source.
  `tcp.connect`'s `*` contributes nothing (A43).
- **A `*` host in `https.connect` emits `https:`** in `connect-src`, `img-src`, `font-src` and
  `media-src`. Every request it admits reaches this app's own `protocol.handle`, workers
  included, and `fetchThirdParty` re-authorises it, still refusing loopback and private
  addresses (measured). A native WebSocket is the one thing the handler cannot re-check, and
  `https:` does not admit `wss:` (measured, `test/app-loading/e2e-served-csp.test.ts`).
- **No `form-action`.** Restricting it would also refuse a form-post sign-in's redirects, and
  would bound nothing: top-level navigation is not governed by CSP (A42).
- **`object-src 'none'`.** `default-src 'self'` alone still admits a same-origin
  `<object>`/`<embed>` document, and Chromium reports such a document's response to
  `onHeadersReceived` as resource type `object` (measured, Electron 44) -- a granted-without-
  install origin's `'unsafe-inline'`-free policy reaches it only because
  `../../main/install/granted-origin-csp.ts`'s own filter and `documentOriginOf` also treat
  `object` as a document type. `object-src 'none'` is the second, unconditional lock: even if
  that filter's document-type list were ever wrong, no such document loads at all.
