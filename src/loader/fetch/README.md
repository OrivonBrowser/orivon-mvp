# `src/loader/fetch/`: turning a hint into a validated bundle

**What lives here.** `bundle.ts` (`fetchBundle`, the orchestration), `asset.ts` (the one-asset
fetch and the bounded pool), `budget.ts` (the `Fetch` type, byte cap and idle deadline),
`install-origin.ts` (T12/A46's public-unicast guard), `eth-origin.ts` (the `.eth` exception),
`content-root.ts` (the root-CID request header), `update-check.ts` (the update-check interval
and conditional-request validators) and `undeclared-assets.ts` (warning about subresources the
manifest doesn't declare).

**What it depends on.** [`../../contracts/`](../../contracts/), [`../manifest/`](../manifest/)
and [`../ddoc-declaration.ts`](../ddoc-declaration.ts). Value imports run one way into
[`../cache/`](../cache/) (`bundle.ts` reads `LoaderStorage`'s type); `cache/install.ts` imports
`undeclared-assets.ts` back, so the two folders depend on each other in both directions at this
one seam.

**What it must never import.** [`../../shim/`](../../shim/) -- see the parent README's "What it
must never import".

**Owner stream.** `loader`, build step 4.

## Design notes

**The install origin's hostname must resolve as public-unicast before that fetch, no exception**
([`install-origin.ts`](install-origin.ts), T12/A46). This is the shell itself, unsandboxed,
making the very first request, with no grant and no manifest yet to gate it, so a hint pointing
at a loopback, private, link-local or cloud-metadata address is refused outright. A loopback
origin's hint never reaches the loader: it is granted without being installed
([`../../main/install/grant-without-install.ts`](../../main/install/grant-without-install.ts)),
and nothing is fetched from it as a bundle.

**Why [`bundle.ts`](bundle.ts) is its own file, not part of `../index.ts`.** Split out
per [`code-guidelines.md`](../../../docs/development/code-guidelines.md) Rule 2: it owns exactly
one concern: turning `(fetch, hintedUrl)` into a validated bundle. TOFU versus `decideUpdate()`
branching is `../index.ts`'s job, and persistence is [`../cache/install.ts`](../cache/install.ts)'s.
[`asset.ts`](asset.ts) holds the one-asset half and the bounded pool.

**Assets are fetched four at a time, and a download ends for going quiet, never for being
long.** `FETCH_CONCURRENCY` (4) assets share one `ByteBudget`, taken chunk by chunk in one
synchronous step, so parallel fetches can never together pass `MAX_BUNDLE_BYTES`; the first
failure aborts the rest. Each fetch has an idle deadline (`FETCH_IDLE_TIMEOUT_MS`, 20 s without
a response or a new chunk), so a 64 MiB asset on a slow but steady link finishes, and the whole
operation has `BUNDLE_TIMEOUT_MS` (30 minutes, about 300 KB/s for a full 512 MiB bundle), so a
peer trickling one byte just inside the idle deadline is still cut off. Both numbers are
AI-recommended and uncalibrated (A15).

**There is no `assetPaths` parameter anywhere in this directory.**
`fetchBundle` reads the app's file list off the manifest itself (`manifest.entry` unioned with
`manifest.assets`, [`ADR-0011`](../../../docs/decisions/ADR-0011-manifests-declare-their-own-asset-list.md))
once it has fetched and parsed it, never supplied by a caller. It cannot be a caller's job: the
well-known manifest path is fixed and known only to `fetchBundle` itself, so nothing external
ever has a parsed manifest to read `assets` off *before* calling `load()`; the caller of `load()`
only ever has `hintedUrl`, the same thing a passive hint listener has.

`entry` is unioned into the fetched set unconditionally, not only when convenient: it is a leaf
of the bundle like any other declared asset, and the entry-leaf check needs it fetched to find
it. **Some of `bundle.ts`'s checks are unreachable through the public API, on purpose.**
Several guard against a hostile asset list (an absolute cross-origin URL, a path-traversal string,
two names that collide under case-folding, too many entries), but `../manifest/manifest.ts`'s own
validation (`readAssets`/`validateRelativePath`/`MAX_ASSETS`) rejects every one of those shapes
before `fetchBundle` ever sees them. They stay in `bundle.ts` as defence in depth (this function
must not quietly trust that `manifest.ts`'s validation is airtight), and their test coverage lives
in [`../manifest/tests/manifest.test.ts`](../manifest/tests/manifest.test.ts), which exercises
the same input shapes. A *redirect* landing two distinct declared names, or a redirected entry,
at a different canonical path than declared cannot be produced by this file's suite at all, for
the reason below.

**`fetchBundle` trusts the url it requested, never `response.url`, and follows only a
same-origin redirect.** Real Electron's `net.fetch` reports `response.url` as the empty string on
every ordinary response (measured, `docs/open-questions.md` A59/A141), so the same-origin and
canonical-path checks trust the url they *requested* (`manifestUrl`, `assetUrl`), and every asset
is pinned under that path. That is safe only because a `Fetch` may never deliver bytes from
another origin, a hard requirement on any implementation (that type's own doc comment,
[`budget.ts`](budget.ts)). Refusing every redirect met it, but also refused real
static hosts, which answer `/index.html` with a redirect to `/` (Cloudflare Pages, Vercel) or
`/app` with `/app/` (GitHub Pages). So [`../electron/fetch.ts`](../electron/fetch.ts)'s `netFetch`
uses `net.request` with `redirect: 'manual'` and shows each hop to `redirectRefusal` before taking
it: same scheme, host and port, at most `MAX_REDIRECTS` (5), or the request is aborted. The bytes
of a followed hop are pinned under the requested path, still on the origin being installed.

**The root document is declared by its file name.** `entry: "index.html"` is fetched at
`/index.html` (following such a redirect to `/` where the host sends one) and served at `/`; a
bare root cannot itself be a pinned leaf, since `/` is not a valid canonical path, so
`entry: "/"` is refused with that hint. An asset whose name promises script, style, wasm or JSON
but whose response is an HTML page is refused too ([`asset.ts`](asset.ts)'s `servedAsHtml`): an
SPA host answers a missing file with `200` and its index page, which would otherwise be pinned as
the script and fail later with an opaque syntax error.

Two more checks are unreachable through the public API for the same reason: `bundle.ts`'s
entry-leaf check (`ADR-0009` amendment #2), because `entryPath` and the asset loop's own canonical
path are the identical computation for the entry's own asset, so they cannot disagree without a
bug in that computation itself, which no test can manufacture without reintroducing the bug; and
`bundleTree()`'s own case-folding collision check, which has direct coverage in
[`bundle-hash.test.ts`](../../broker/policy/tests/bundle-hash.test.ts) instead. Both stay as
defence in depth against their own computations ever drifting apart.

**Undeclared files are named at install, never added.** An entry document that loads a
same-origin script, stylesheet or image its manifest's `assets` leaves out installs cleanly and
then renders blank: the file is not pinned, so the cache refuses it. When a bundle is newly pinned,
[`undeclared-assets.ts`](undeclared-assets.ts) scans the entry document's `src`/`href` on
subresource elements and logs every same-origin path the pinned set lacks. It only warns: ADR-0011
has the loader read the list, never infer it, and a runtime `import()` a scan cannot see is the
publisher's to declare either way.

**The real adapter (`electronFetch`/`netFetch`) is tested for real, not only through a stub
`Fetch`.** [`test/e2e-loader-adapter.test.ts`](../../../test/e2e-loader-adapter.test.ts) drives the
real `netFetch` (and, for the one case its own address guard
allows, the real `electronFetch`) inside a real Electron process against a real local server,
including a real same-origin and a real cross-origin redirect, so the redirect rule this section
depends on is proven rather than assumed.

**Why [`install-origin.ts`](install-origin.ts) is its own file.** Split out of `bundle.ts`
per Rule 2 (adding the T12/A46 guard pushed that file to 524 lines): it owns exactly one
question, "may this hostname be installed at all," independent of everything else `fetchBundle()`
does once that question is answered. Tested through `tests/bundle.test.ts` rather than a file of
its own, the same way `../manifest/capabilities.ts` is tested through `manifest.test.ts`, since it
has no caller-visible contract beyond what `fetchBundle()` already exercises.

**An installed app is checked for an update at most once an interval, and an unchanged app costs
one small request.** Every page load of an app reports its hint. `createLoader`'s
`updateCheckIntervalMs` (`UPDATE_CHECK_INTERVAL_MS`, one hour, AI-recommended) answers
`'up-to-date'` without any request while the last check for that origin is younger than that.
The time is kept in the origin's storage ([`update-check.ts`](update-check.ts),
`apps/<origin-hash>/update-check.json`, beside `pin.json` and never inside `code/`), so a restart
does not reset it; a rejected check is not recorded, so a failure is retried on the next visit,
and a time in the future (the clock went back) counts as stale. Once the interval has passed, the
manifest is requested with `If-None-Match`/`If-Modified-Since` from the manifest response that
was last pinned, and a 304 answers `'up-to-date'` before any asset is requested. Those validators
are stored with the pinned manifest's leaf and sent only while the pin still holds that leaf, so
a 304 always means "the manifest you have pinned"; an accepted prompt that pins a new manifest
makes the next check a full one, which re-learns them. **What this assumes of a publisher:** an
update is noticed when the manifest changes, so every release must change the manifest (its
`version` at least). A bundle whose files change under a byte-identical manifest is not picked
up until the manifest changes. A cache that fails verification at start forgets its record
(`registerServingFor`), so the next visit checks, and heals, in full.
