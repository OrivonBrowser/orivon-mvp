# `src/main/browsing/`: what the address bar and tab strip are made of

**What lives here.** `omnibox.ts` (URL or search), `bookmarks.ts` (the bookmark store: the tree in memory and `bookmarks.json` on disk),
`bookmark-tree.ts` (the tree and every operation on it, pure), `bookmark-import.ts` (whole trees in and out in one
operation), `bookmark-file.ts` (reading and writing the file, pure),
`bookmarks-domain.ts` (what the Bookmarks page may ask, each field checked), `bookmarks-undo.ts` (what a delete in it can take back),
`bookmarks-html-export.ts` (the Netscape bookmark file, pure) and `bookmarks-export-runner.ts` (the save dialog and the write),
`favicon.ts`, its pure byte-sniffing half `favicon-format.ts` (a tab's icon as a `data:` URL) and `favicon-timeout.ts` (how long a fetch may take),
`search-engines.ts` (the built-in engines, their keywords and suggestion addresses, and the template rule), `search-resolve.ts` and
`search-current.ts` (which engine a typed search goes to, pure), `search-engine-store.ts` (the engines a person keeps in
`search-engines.json`; its rules are in `search-engine-rules.ts` and the starting site engines in `site-engines.ts`),
`favicon-cache.ts` (the icons already fetched), `bookmark-types.ts` (the node, bar item and import shapes, types only), `site-trust.ts` (the Web3 Score page and the
toolbar shield's data), `site-home.ts` (where the content shown says it lives, which decides whether a judged level counts, `ADR-0056`), `score-provider-client.ts` (asks the chosen Web3 Score provider, `ADR-0054`), `page-score-lookup.ts` (what
`orivon.trust.websiteScore` answers, `ADR-0058`), and `eth-gateway.ts` (which web addresses are an ENS gateway's copy of a `.eth` name, `eth.limo` and `eth.link`, and the `.eth` address each stands for (`ethGatewayTarget`, `isEthGatewayAddress`); pure, with no `electron`; [`../shell/eth-gateway-redirect.ts`](../shell/eth-gateway-redirect.ts) acts on it). `site-trust.ts` is pure: its caller,
[`../permissions/site-info-controller.ts`](../permissions/site-info-controller.ts), hands it the
pin, pin coverage, a `.eth` name's evidence and the developer overrides, so it never reaches for
the loader, the verifier or `../dev/` itself.

**Tied to Electron.** `favicon.ts` and `score-provider-client.ts` import `electron`, only
dynamically and only for `net.fetch`: outside a real Electron process the package's entry point is
a path string.

**What it depends on.** [`../../broker/policy/`](../../broker/policy/) (`address.ts`,
`origin.ts`; `pin.ts`, `connect.ts` types), [`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts)
(`writeFileAtomicAsync`, `bookmarks.ts`'s own write), [`../../trust/`](../../trust/),
[`../../loader/electron/resolve.ts`](../../loader/electron/resolve.ts),
[`../../protocols/builtin.ts`](../../protocols/builtin.ts),
[`../../protocols/ipfs/names.ts`](../../protocols/ipfs/names.ts) (`canonicalCid`),
[`../../protocols/resolution/dns-name.ts`](../../protocols/resolution/dns-name.ts) (`dnsName`, for `eth-gateway.ts`),
[`../../broker/transport/token-bucket.ts`](../../broker/transport/token-bucket.ts) and `../../broker/errors.ts`
(`page-score-lookup.ts`'s rate limit and its `limit` refusal),
[`../verifier/name-evidence.ts`](../verifier/name-evidence.ts) (types), `node:crypto`,
`node:fs/promises`, `node:path`, `node:stream`.

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts): `favicon.ts` has no
dependency on tab-collection state, which keeps it importable under plain vitest.

**Owner stream.** `shell`. Maintenance only.

## Design notes

**A page's score lookups share nothing with the shell's, or with another page's.** `page-score-lookup.ts` keeps one
`createScoreProviderClient` per calling origin (the sixteen most recent) and never uses `services.scoreProvider`:
one cache for everyone would let a page time an answer to learn which sites the person had opened. A `.eth` name is
resolved in the caller's own verifier partition for the same reason (A256). Each origin also has a token bucket
(128 lookups, refilling 2 a second): Explore asks about some sixty sites on one load, a page that loops is refused
`limit`. Every other failure, a provider that is down, a name that does not resolve, an address that names no
content, answers `level: null`, because none of them is the page's fault.

**A keyword is the first word of a search, never an address.** `search-resolve.ts` takes `<keyword> <terms>` only when
something follows the keyword, so `w` alone and `w.com` are parsed as before and a keyword cannot stand in for a host.
The tab's Enter and the dropdown's first row both call `resolveCurrent`, so the row never names an engine Enter would
not reach. Built-in keywords are fixed; the site engines (Wikipedia, YouTube, GitHub, OpenStreetMap) are ordinary
entries of `search-engines.json`, which remembers a removed one so it stays removed. A private session reads the file
its opener had and refuses every write.

**`bookmarks.json` is a tree with stable ids, and nothing else reads its text.** Format 2 holds three roots (`bar`,
`other`, `reading`) of nested nodes, each with a random id that stays the same from the first load on. A file that is a bare array
of pages (the older format) is converted on load, in order, into the bar with fresh ids and the file's date, and the
file is rewritten at once with the old one kept as `bookmarks.json.bak`. A version this build does not know, or a
file that is not JSON, loads as an empty tree and is left alone until the person changes something; the first write
then keeps it as `.bak` too. Every address is checked again on load, so a hand-edited `javascript:` page never
reaches a view; a bad icon loses the icon, never the page.

**The tree is two maps, and every operation returns a new tree.** `bookmark-tree.ts` holds the nodes by id and each
folder's child ids in order, so an id lookup and a move are cheap, and a refused operation (a folder into its own
subtree, a level past 12, the 20,001st node) returns `null` and changes nothing. `move`'s index is a position in the
destination's list as it stands, so "drop before the third item" means the same from either side. The reading list
holds pages only.

**Main holds the tree; a surface receives what it shows and sends ids back.** The chrome gets the bar's items when
they change, never the whole tree on every tab event, and an overlay or a page never sends an address to open: main
reads it from the store and checks it again (`../shell/bookmarks-bar/`).

**A delete in the manager is undone from memory, not asked about first.** The domain keeps the last removal (one token,
60 seconds, at most 2,000 nodes) as nested inputs with the place each held, and puts it back with `importTree`; ids are
new after an undo, so the answer names the restored rows. A bigger delete is final and the page says so by offering no
Undo. The reading list is not shown in the manager: every id it sends is checked to sit under the bar or Other
bookmarks.

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

**A verifier-served host gets a longer budget** (`VERIFIED_FAVICON_TIMEOUT_MS`, *provisional*). An icon on
`<cid>.ipfs.orivon` or a `.eth` name is fetched block by block from gateways and checked, so five seconds
aborts a slow load, and a capture that fails leaves the globe until the page announces another icon set. Such a host
resolves to loopback, so `isSafeFaviconUrl` passes it only as the declaring page's own origin; the longer budget
reaches nothing a page could not already load. Real gateways have not measured the number.

**Not bounded, on purpose for now:** repeated `page-favicon-updated` events per tab (bounded per
event by `MAX_FAVICON_CANDIDATES`, and only public hosts pass the gate; a real bound needs
per-tab state in `../shell/tabs.ts`).

**`faviconCache` is bounded** by entry count and total size, least recently used dropped first
(`favicon.ts` holds the provisional numbers), because a page can name any number of icon URLs.
It stores only an icon its capture kept, never one that landed after the tab moved to another
origin or a newer icon set.

**[`eth-gateway.ts`](eth-gateway.ts) leaves a gateway address alone when it is not a plain name.** The gateway's own `www` and `dns`
hosts, a bare `eth.limo`, an address with an explicit port, a trailing-dot host, an `xn--` label (the verifier refuses
internationalised names) and anything `dnsName` refuses have no `.eth` address to map to, so the page opens as typed. Only
`eth.limo` and `eth.link` are known gateways; another is one more entry in `ETH_GATEWAY_SUFFIXES` when a need names it.
The result's host ends in `.eth`, so it is never a gateway address again and a redirect cannot loop.
