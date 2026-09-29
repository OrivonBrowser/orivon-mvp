# `src/main/browsing/`: what the address bar and tab strip are made of

**What lives here.** `omnibox.ts` (URL or search), `bookmarks.ts` (the bookmarks bar, on disk),
`favicon.ts` and its pure byte-sniffing half `favicon-format.ts` (a tab's icon as a `data:` URL),
`favicon-cache.ts` (the icons already fetched), and `site-trust.ts` (the Web3 Score page and the
toolbar shield's data). `site-trust.ts` is pure: its caller,
[`../permissions/site-info-controller.ts`](../permissions/site-info-controller.ts), hands it the
pin, pin coverage, a `.eth` name's evidence and the developer overrides, so it never reaches for
the loader, the verifier or `../dev/` itself.

**Tied to Electron.** `favicon.ts` is the one file that imports `electron`, and only dynamically:
outside a real Electron process the package's entry point is a path string.

**What it depends on.** [`../../broker/policy/`](../../broker/policy/) (`address.ts`,
`origin.ts`; `pin.ts`, `connect.ts` types), [`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts)
(`writeFileAtomicAsync`, `bookmarks.ts`'s own write), [`../../trust/`](../../trust/),
[`../../loader/electron/resolve.ts`](../../loader/electron/resolve.ts),
[`../../protocols/builtin.ts`](../../protocols/builtin.ts),
[`../verifier/name-evidence.ts`](../verifier/name-evidence.ts) (types), `node:fs/promises`,
`node:path`, `node:stream`.

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts): `favicon.ts` has no
dependency on tab-collection state, which keeps it importable under plain vitest.

**Owner stream.** `shell`. Maintenance only.

## Design notes

**Main fetches favicons to a `data:` URL; the renderer never fetches one.** *Provisional.* The
chrome view's CSP (`img-src 'self' data:`) is a one-line guarantee that the one privileged,
cookie-bearing view makes zero outbound requests. Letting it `<img src>` a page-chosen `https://`
URL would open that CSP and hand every page a silent tracking request from the chrome origin.

**An SVG favicon is shown only as an `<img>`: never render one any other way.** In the tab strip,
the bookmarks bar and the new-tab page, an `<img>`-loaded SVG runs no script and makes no network
request. That is the whole guarantee, and it is narrower than inert: `data:` URLs inside the
SVG load (an icon embedding a raster relies on it), SMIL and CSS animations run, and `<use>`,
filters and `<foreignObject>` all reach Chromium's SVG engine inside the privileged chrome
renderer and the new-tab page. The sniffer refuses a DOCTYPE with an internal subset, where an
entity-expansion bomb is declared; everything else rests on Chromium. SVG bytes also persist, in
`bookmarks.json`, sniffed again on every load. Whether to refuse more is `open-questions.md` A270.

**The fetch is T12-gated per hop** (`isSafeFaviconUrl`, whose doc comment has the rules and the
loopback-page carve-out). It is the one main-process network call that fires on ordinary
browsing with no manifest and no grant, from a URL the page chose. It reuses the broker's address
classification and the loader's resolver rather than a second copy (code-guidelines Rule 3);
`open-questions.md` A124 is the one way it is weaker than the install path.

**Not bounded, on purpose for now:** repeated `page-favicon-updated` events per tab (bounded per
event by `MAX_FAVICON_CANDIDATES`, and only public hosts pass the gate; a real bound needs
per-tab state in `../shell/tabs.ts`).

**`faviconCache` is bounded** by entry count and total size, least recently used dropped first
(`favicon.ts` holds the provisional numbers), because a page can name any number of icon URLs.
It stores only an icon its capture kept, never one that landed after the tab moved to another
origin or a newer icon set.
