# `src/loader/`: the app loader

**What lives here.** Manifest discovery at `/.well-known/orivon.json`, asset fetch and cache,
per-version hash pinning, the hash tree a site publishes about its bundle
(`/.well-known/orivon-ddoc.json`), and the update decision (silent / re-consent / capability
prompt / reject).

| Folder | Holds |
|---|---|
| (top level) | `index.ts` (`createLoader`/`load()` orchestration), `name-update.ts` (a moved name: only the new manifest is fetched, `update-available`, and `applyUpdate` of exactly the offered root), `update-offer.ts` (the ticks a person left on offers), `load-result.ts`, `subsystem.ts`, `dev-serve.ts`, `leaf-hash.ts` and `ddoc-declaration.ts` (used across every folder below) |
| [`manifest/`](manifest/) | Parsing and validating the manifest |
| [`fetch/`](fetch/) | Turning a hint into a validated bundle |
| [`cache/`](cache/) | Writing and pruning what's on disk |
| [`serve/`](serve/) | Answering a request against the pinned bundle |
| [`reach/`](reach/) | The third-party reach path |
| [`electron/`](electron/) | The Electron-specific machinery: `protocol.handle`, `net`, DNS |

**What it depends on.** [`src/contracts/`](../contracts/) and [`src/broker/`](../broker/)
(for storage and the grant ledger).

**What it must never import.** [`src/shim/`](../shim/).

**Tied to Electron?** Partly ([`ARCHITECTURE.md`](../../ARCHITECTURE.md) section Where things live):
the update decision is pure policy, fetching and serving the cache are Electron-specific
machinery, and only `electron/` imports `electron`.

**Owner stream.** `loader`, build step 4.

**Never probe automatically.** An unsolicited request to every origin visited is an attributable
*"this visitor runs Orivon"* signal. The one discovery trigger is a `<link
rel="orivon-manifest">` hint in HTML already delivered, and the well-known path is fetched
**only after** seeing it (`capability-api.md` section How a URL becomes an app).

**The update decision is where a silent failure is a security failure.** Its failure mode is "no
prompt appeared", which no manual checklist catches, and the capability at stake is
`tcp.connect *:*`. Re-consent triggers on a **subset check over the granted pattern set**, not on
capability kinds ([`capability-api.md`](../../docs/architecture/capability-api.md) A9 section 2). Two
inputs stop an answered question being asked again, and neither grants anything: a kind switched
off in the site-info popover while unheld (`LoadContext.declinedCapabilities`), and what the
pinned manifest already declared (`previouslyDeclaredPatterns`). A manifest widening a capability
still held always prompts.

## Design notes

Topics cited elsewhere as this page's Design notes live with the folder that owns them:

| Topic | Home |
|---|---|
| A bundle streams to staging and is hashed from there, never whole in memory | [`ADR-0009`](../../docs/decisions/ADR-0009-the-bundle-hash-is-an-app-s-content-identity.md)'s streaming amendment, `fetch/asset.ts`, `leaf-hash.ts` |
| Serving streams from disk; the whole-tree re-verification cost; what the served CSP admits | [`serve/`](serve/README.md) |
| The asset list read off the manifest, and `fetchBundle`'s checks unreachable on purpose | [`fetch/`](fetch/README.md) |
| The third-party reach path, A199's cancellation, A200's allowance | [`reach/`](reach/README.md) |
| Restoring at startup, a pin that fails verification, CSP read per request | [`electron/`](electron/README.md) |
| Why an install never prunes | [`cache/`](cache/README.md) |

**An installed app at a name is offered a move, never taken along (`ADR-0056`).** `load()` of a name
that points at another root fetches that root's manifest alone (`fetch/manifest-at-root.ts`, pinned to the
root) and returns `update-available`; the pin does not move. The bundle is fetched in two cases only: the
manifest is byte-identical to the pinned one (the same files republished, which moves the pin silently when
the bundle hash is equal and is an offer otherwise), and `applyUpdate`, which fetches the offered root, is
refused when the name has moved again, and asserts the content it got is that root. A check is repeated at
most every 5 minutes per origin on a visit, whatever the hourly record says.

**A staged file is hashed by reading it back, not as its bytes arrive**, because the leaf
preimage puts the content's length before the content, and a declared `Content-Length` is
advisory.

**The site's published hash tree is carried by the loader and judged by its caller**
([`ADR-0029`](../../docs/decisions/ADR-0029-sites-publish-their-bundle-hash-tree.md),
[`ADR-0074`](../../docs/decisions/ADR-0074-a-published-app-is-asked-about-and-checked-before-its-page-is-entered.md)).
Nothing here reads it to decide anything: `load()` installs as it would without it, and a 404, an unreadable file and a mismatch all pass. A
first visit uses `readManifest` (the manifest alone), `readDeclaration` (the tree alone, compared with the manifest the person was asked about),
`serveLive` (the origin answers from the verifier on its own partition, [`serve/live-serve.ts`](serve/live-serve.ts), until its pin replaces it) and, in the
background, `fetchForInstall` (every file, staged, nothing pinned); `src/main/install/first-visit.ts` compares the downloaded tree with the declaration before
`installFetched` ([`ADR-0075`](../../docs/decisions/ADR-0075-a-published-app-is-let-in-when-allowed-and-each-file-is-checked-as-it-is-served.md)).

**The live handler resolves requests as the pinned one does, and checks them with the verifier.** `serve/live-serve.ts` takes the files the manifest lists
(its entry, its `assets` and the manifest) as the set a page may reach, answers anything else `404`, and asks the verifier for the rest naming the leaf the
declared tree gives each (`EXPECT_LEAF_HEADER`) and the root the manifest came from. It sends the headers a pinned response carries
(`serve/asset.ts`'s `policyHeaders`). A `ddoc-mismatch` or `unverifiable` answer, or a listed file the tree has no leaf for, fails the request, is reported
once through `onBadData`, and ends everything it would serve. For an app on an ordinary site it is also the check: it fetches the file itself (`fetchNetwork`, the loader's own guarded fetch, never through the handler), holds it whole, hashes it, and delivers those bytes. `pending-consent.ts` is what is kept of an allowed, not yet pinned app across a restart.
