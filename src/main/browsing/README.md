# `src/main/browsing/`: what the address bar and tab strip are made of

**What lives here.** `omnibox.ts` classifies address-bar input (URL or search). `bookmarks.ts`
is the bookmarks bar's data model and disk persistence. `favicon.ts` fetches a tab's icon to a
`data:` URL. `delivery-provenance.ts` answers ADR-0007's one truthful address-bar signal: is the
active tab served from Orivon's own pinned cache. `site-trust.ts` is the site-info popup's Web3
Score page: `buildSiteTrust` computes the Website level (`../../trust/website-level.ts`) and the
delivery ladder (`../../trust/delivery-ladder.ts`). Pure — the caller (`../permissions/
site-info-controller.ts`) supplies the pin, the cached-or-not flag, pin coverage and a `.eth`
name's evidence (`../verifier/name-evidence.ts`) rather than this file reaching for
`electron-serve.ts` or the verifier itself, matching `../../trust/`'s own "never import another
stream's internals" one layer further out.

**What it depends on.** [`../../broker/policy/`](../../broker/policy/) (`address.ts`,
`connect.ts` types, `origin.ts`, `pin.ts`'s `PinRecord` type),
[`../../trust/`](../../trust/) (`delivery-ladder.ts`, type and value), [`../../loader/`](../../loader/)
(`electron-resolve.ts`, `electron-serve.ts`), `node:fs/promises`, `node:path`. `favicon.ts` is
the only file here that imports `electron`, and only dynamically, for the same reason
[`../self-update/update-check-runner.ts`](../self-update/update-check-runner.ts) does (outside a
real Electron process, `electron`'s entry point is a path string, not the API surface).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts): `favicon.ts` is
deliberately kept with no dependency on tab-collection state, which is what keeps it importable
under plain vitest with no Electron process.

**Owner stream.** `shell`, build step 1, **done**, except `favicon.ts` (queue item 4.5),
`delivery-provenance.ts` (S4-6) and `site-trust.ts` (queue item 4.4). Maintenance only.

## Design notes

**Favicons are fetched from loopback, for a page that is itself on loopback.** A rule of
"public unicast https only" would mean a local dev server never shows an icon, in a tab or in the
bookmarks bar, and `scripts/smoke.mjs`'s own two favicon checks could never pass, since its
fixtures are `http://127.0.0.1`.

The condition is **which page declared the icon**, not just what the icon's address is, and that
distinction is the whole safety argument. A page fully controls its own `<link rel=icon>`, so
allowing loopback unconditionally would let any site you visit drive the privileged main process
into blind, credential-less GETs against every port on your machine, with no origin attached
and none of the Private Network Access rules the renderer itself is held to. Gating on
`isLoopbackPage(pageUrl)` gives a local site its own icon and leaves that reach closed. `http` is
allowed on that path because a dev server is almost never `https`, and an https-only carve-out
would refuse exactly the case it exists for.

Still refused from a local page: private LAN addresses (`192.168.x.x`, link-local), and plaintext
off-machine. Only this machine is in scope. `tests/favicon.test.ts` holds both halves: what is
allowed, and the obfuscated-loopback spellings that stay refused to a public page.

**[`favicon.ts`](favicon.ts): main fetches favicons to a `data:` URL rather than letting the
renderer fetch directly.** Provisional, not yet confirmed. The chrome view's CSP
(`index.html`) is a one-line, readable guarantee today that the one privileged view in this app
makes zero outbound requests. Letting the renderer `<img src>` an arbitrary, attacker-influenced
`https://` URL directly would need `img-src 'self' https:` and hands a hostile page a live
request from the privileged, cookie-bearing chrome origin: a new, silent tracking surface
exactly where this codebase has been careful before (`mvp-scope.md` already flags DuckDuckGo
search itself as a stated "known limitation" for far less: leaving the machine at all). Fetching
in main instead keeps the guarantee intact; the CSP only needs `img-src 'self' data:`.

**[`favicon.ts`](favicon.ts): the fetch is T12-gated (`isSafeFaviconUrl`).** This fetch fires on ordinary browsing, on every tab, with no manifest and no grant --
unlike every other main-process network call in this codebase, which is either fixed
([`../self-update/update-check-runner.ts`](../self-update/update-check-runner.ts)'s
`RELEASES_API`) or gated behind an app install
([`../../loader/install-origin.ts`](../../loader/install-origin.ts),
[`../../loader/electron-fetch.ts`](../../loader/electron-fetch.ts)). A page's own `<link rel="icon">` is fully
attacker-controlled, so without a check `pickFaviconUrl` would hand `fetchFaviconDataUrl` a URL
pointing anywhere, whether `169.254.169.254`, a LAN admin panel or a localhost service, and the main
process would issue a real GET to it. `isSafeFaviconUrl` closes this the same way
`install-origin.ts` closes the equivalent gap for an app install: reuse
[`../../broker/policy/address.ts`](../../broker/policy/address.ts)'s
`classifyAddress`/`isPublicUnicast` and
[`../../broker/policy/origin.ts`](../../broker/policy/origin.ts)'s `isLocalhostName` directly, and
[`../../loader/electron-resolve.ts`](../../loader/electron-resolve.ts)'s `electronResolveHost` for
the one case those cannot answer alone (a hostname, which needs resolving before it can be
classified), never a second implementation of any of the three (code-guidelines.md Rule 3).

Three related questions, and the current answer to each:

- **Accept `http://` for a favicon at all?** No. `isSafeFaviconUrl` refuses it outright --
  refusing plaintext costs a real favicon nothing and closes a downgrade path from an https page.
  This lives in the fetch path, not in `pickFaviconUrl`: that function's own test asserts it still
  *selects* an `http://` candidate (picking a URL is not fetching one), so the refusal sits where
  the fetch actually happens.
- **Bound the number of favicon fetches one tab can drive?** Not bounded. `page-favicon-updated`
  can fire repeatedly and nothing caps it, but that is a resource-exhaustion question (T11b's
  shape) against what `isSafeFaviconUrl` allows through, which is only *public* hosts, not a T12
  address-reach question. Bounding it well needs new per-tab state in `../shell/tabs.ts` (which
  `favicon.ts` deliberately has no dependency on, so it stays importable under plain vitest), a
  design decision of its own.
- **Bound `faviconCache`?** Not bounded. Its own comment calls the unbounded, process-lifetime
  cache a deliberate "v0, revisit later" choice, and it is orthogonal to T12: reaching a private
  address is not something the cache makes worse or better.
