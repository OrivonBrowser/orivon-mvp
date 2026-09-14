# `src/main/` — the Electron main process

**What lives here.** The browser shell: the window, tab management, the omnibox, shell IPC, and
the subsystem registry every other stream plugs into.

**What it depends on.** `electron`, [`src/contracts/`](../contracts/).

**What it must never import.** [`src/renderer/`](../renderer/) code. The main process and the
renderer communicate over IPC, never by sharing modules.

**Owner stream.** `shell` — build step 1, **done**. Maintenance only; other streams add
themselves via `subsystems.ts` rather than editing here.

| File | Responsibility |
|---|---|
| `index.ts` | Entry point. Runs the subsystem registry, then creates the window |
| `registry.ts` | `Subsystem`, and the two phase runners. Unit tested, no Electron at runtime |
| `subsystems.ts` | **The append point.** Adding a subsystem is two lines here |
| `window.ts` | Composes the frameless `BaseWindow`: chrome view on top, active tab view below |
| `tabs.ts` | `TabManager` — creating, switching, closing, bounds, and deciding when a navigation must repartition a tab |
| `tab-view.ts` | Pure: builds one tab's `WebContentsView` and derives its session partition from a URL |
| `tab-types.ts` | The wire-format types (`TabState`, `TabsSnapshot`, `ShellState`, `Bounds`) pushed to the chrome UI |
| `ipc.ts` | Shell IPC channels between the chrome view and main |
| `omnibox.ts` | Address-bar input: URL or search. Unit tested |
| `delivery-provenance.ts` | S4-6, `ADR-0007`: whether the active tab is being served from Orivon's own pinned cache -- the address-bar dot's one truthful signal |
| `permission-gate.ts` | Denies every Chromium permission (camera, clipboard, notifications, …) by default, on every session a tab can reach |

## Two things not to rediscover

**`webPreferences` is load-bearing.** `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false` are what keep the preload's port out of the page
([`security-model.md`](../../docs/architecture/security-model.md) T17). A hookify rule rejects
edits that weaken them.

**`BaseWindow`, not `BrowserWindow`.** `BrowserWindow` supports a single full-size web view;
the shell needs a chrome view *plus* tab views, which only `BaseWindow` composes.

**Main and preload are CommonJS; only the renderer is ESM.** A sandboxed preload has no ESM
context at all. `sandbox: true` is non-negotiable, so the preload must be CJS, and matching
main to it avoids a two-format build for no gain. An ESM main process does work — verified
against Electron 44 — if a reason to switch ever appears.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**[`index.ts`](index.ts) — do not re-add `ozone-platform: x11`.** Tried and reverted 2026-08-26,
same session: it was tried on a since-corrected diagnosis (a report of "no window ever appears"
was first misread as the window opening on the wrong monitor, chased partway down a
Wayland-can't-control-window-position path). It made things strictly worse — the GPU process
segfaulted under XWayland on this machine (`exit_code=139`) and the window stopped rendering at
all — and was reverted immediately. The real bug was never about display selection; see
[`window.ts`](window.ts)'s `showOnce` comment for the actual root cause and fix (`ready-to-show`
unreliable when loading from the dev server).

**[`tabs.ts`](tabs.ts) split into three files (2026-09-10), along the seam "construct/partition
a view" vs. "manage the collection of tabs" vs. "the shapes pushed to the chrome UI".** Landed
alongside the fix for a real bug: per-app `session` partitions (queue item 0.4) originally only
computed a tab's partition inside `createTab()`, which is not the path a person actually takes
— typing a URL into the omnibox, or the dashboard's own navigate command, both go through
`TabManager.navigate()` instead, which never touched partitioning at all. Fixed by having
`navigate()` swap in a fresh `WebContentsView` (`repartitionView()`, in `tabs.ts`) whenever the
target's origin differs from the tab's current partition — Electron fixes a partition at
construction, so a live tab can only change session by replacing its view outright, preserving
the tab's id/position/active-state while doing so. That swap logic, plus the event-wiring it
shares with `createTab()` (favicon capture, title/loading pushes, the crash-cleanup listener,
T18's popup-to-new-tab redirect), pushed `tabs.ts` from 468 to 550 lines — over Rule 2's 500.
Rather than pad `tabs.ts`'s own header to explain the shape (Rule 1's own test: a maintainer
editing `navigate()` does not need to know WHY the file is split, only that it is), the pure
parts were moved out: `tab-view.ts` (view construction and origin→partition derivation, no
`TabManager` state) and `tab-types.ts` (the wire-format interfaces, no logic at all). Both are
re-exported from `tabs.ts` where an external file already imported them, so no other file's
import needed to change. One easy mistake this fix could have made, and did not: a deliberately
swapped-out OLD view's own `'destroyed'` listener must be stripped *before* `close()` is called,
or the teardown would incorrectly call `forgetTab()` on a tab that is not actually closing —
`src/main/tests/tabs.test.ts` exercises this directly with a fake `webContents` that emits
`'destroyed'` synchronously from `close()`, the same way real Electron destruction can.

**[`tabs.ts`](tabs.ts) — what `TabManager`'s `ctx: SubsystemContext` is for, and why one half
of it is unused.** `ctx.broker` is read by every `makeTabView` call site (`appTabArgsFor`,
ADR-0017) to decide the `fetch()`-routing flag. It stays `Broker | undefined`, so a run where
the broker subsystem is absent simply never sets the flag — the same fallback shape
`partitionForTarget` already has. `ctx.loader` is threaded through but read nowhere yet: it is
what the not-yet-built discovery-trigger listener needs in order to install an app the moment a
tab's page shows its `<link rel="orivon-manifest">` hint (A60/A61, `docs/open-questions.md`).
It was threaded through on its own, deliberately ahead of that behaviour, per
`docs/development/parallel-work.md`'s append-only-first discipline — so do not delete it as dead.
Whoever wires it must treat an absent loader as "the discovery trigger is disabled this run",
never assume it is present: `loaderSubsystem` is not `critical`, unlike the broker.

**[`tabs.ts`](tabs.ts) — a redirect, clicked link, form submission or script navigation now
repartitions a tab too, not only a typed cross-origin navigation (A108/A109,
`docs/open-questions.md`; owner decision D-0010 item 2).** `navigate()` was the only code path
that ever computed a partition, and it is reached only from the omnibox and the dashboard's own
navigate command — every other way a tab reaches a new origin bypassed it. Fixed by having
`wireView()`'s existing `did-navigate` handler also call `repartitionView()`, the same swap
`navigate()` already used, whenever the *committed* URL's origin differs from the tab's current
partition (`tab-view.ts`'s new `partitionChanged`, factored out so `navigate()` and this handler
can never compute the comparison two different ways). The file's own header previously justified
the absence of any origin-locking with "that lock applies to granted apps, which do not exist
until build step 4" — stale since #127/#129 made grants real and persisted; corrected as part of
this fix rather than left to mislead the next reader.

**The residual this leaves, deliberately not papered over.** `did-navigate` fires only once a
navigation has already committed — by then the new origin's page has already rendered once
inside the OLD partition and may already have read from it. This swap corrects the partition
going forward; it does not undo an early read. The stronger shape, `will-navigate`/`will-redirect`
with `preventDefault()` and a re-entry through the partition-aware path, catches it before commit
— but costs a fresh view and a lost navigation-history entry on every ordinary cross-origin link
click, not only a redirect, which is why A109 exists as its own tracked item rather than being
folded into this fix. Built the owner-specified shape (reuse `repartitionView`, do not invent a
second mechanism); the earlier-interception alternative is registered as an open question for the
owner, not chosen silently either way.

One thing this fix must not get wrong, and the dashboard tab in particular tests for it: the
dashboard's own dev-mode URL is a real `http(s)` address, so treating its OWN first `did-navigate`
the same as an ordinary tab's would see partition `undefined` -> a real partition as an "origin
change" and repartition the dashboard into an app partition on its very first load. The handler
excludes `record.isDashboardTab` explicitly rather than relying on `partitionChanged` alone to
catch this case.

**[`permission-gate.ts`](permission-gate.ts) — wired through `app.on('session-created', ...)`,
not a call inside `tab-view.ts`'s `makeTabView()`.** Electron fires that event exactly once for
every `Session` it ever instantiates in this process -- `session.defaultSession`'s own creation
included -- so one listener, attached before anything can create a session, reaches every future
`session.fromPartition(...)` call too, including ones no code here has written yet. A handler
installed only at `makeTabView`'s own call site would miss the default session (used by the
chrome UI and every rejected or dashboard-bound tab) and any session a later stream creates some
other way; enumerating today's known partitions once at startup would still miss a partition a
tab opens after that point, which is most of them -- `partitionFor(origin)` sessions come into
being as tabs open, not at startup. The subsystem is listed first in `subsystems.ts`, ahead of
everything else, so its `beforeReady` attaches the listener before any other subsystem's own
`beforeReady` gets a chance to create a session.

**[`favicon.ts`](favicon.ts) — main fetches favicons to a `data:` URL rather than letting the
renderer fetch directly.** AI recommendation, not yet an owner decision. The chrome view's CSP
(`index.html`) is a one-line, readable guarantee today that the one privileged view in this app
makes zero outbound requests. Letting the renderer `<img src>` an arbitrary, attacker-influenced
`https://` URL directly would need `img-src 'self' https:` and hands a hostile page a live
request from the privileged, cookie-bearing chrome origin — a new, silent tracking surface
exactly where this codebase has been careful before (`mvp-scope.md` already flags DuckDuckGo
search itself as a stated "known limitation" for far less: leaving the machine at all). Fetching
in main instead keeps the guarantee intact; the CSP only needs `img-src 'self' data:`.

**[`favicon.ts`](favicon.ts) — the fetch is T12-gated (`isSafeFaviconUrl`), added after review found
it was not.** This fetch fires on ordinary browsing, on every tab, with no manifest and no grant --
unlike every other main-process network call in this codebase, which is either fixed
(`update-check-runner.ts`'s `RELEASES_API`) or gated behind an app install
(`loader/install-origin.ts`, `loader/electron-fetch.ts`). A page's own `<link rel="icon">` is fully
attacker-controlled, so without a check `pickFaviconUrl` would hand `fetchFaviconDataUrl` a URL
pointing anywhere -- `169.254.169.254`, a LAN admin panel, a localhost service -- and the main
process would issue a real GET to it. `isSafeFaviconUrl` closes this the same way
`install-origin.ts` closes the equivalent gap for an app install: reuse `policy/address.ts`'s
`classifyAddress`/`isPublicUnicast` and `policy/origin.ts`'s `isLocalhostName` directly, and
`loader/electron-resolve.ts`'s `electronResolveHost` for the one case those cannot answer alone (a
hostname, which needs resolving before it can be classified) -- never a second implementation of
any of the three (code-guidelines.md Rule 3).

Three follow-on questions the review raised, and what this fix does about each:

- **Accept `http://` for a favicon at all?** No. `isSafeFaviconUrl` refuses it outright --
  refusing plaintext costs a real favicon nothing and closes a downgrade path from an https page.
  This lives in the fetch path, not in `pickFaviconUrl`: that function's own test asserts it still
  *selects* an `http://` candidate (picking a URL is not fetching one), so the refusal has to sit
  where the fetch actually happens or it would force rewriting an assertion the fix has no
  security reason to touch.
- **Bound the number of favicon fetches one tab can drive?** Not in this fix. `page-favicon-
  updated` can fire repeatedly and nothing caps it, but that is a resource-exhaustion question
  (T11b's shape) against whatever `isSafeFaviconUrl` still allows through -- i.e. only *public*
  hosts, once this fix lands -- not a T12 address-reach question. Bounding it well needs new
  per-tab state in `tabs.ts` (which favicon.ts deliberately has no dependency on, so it stays
  importable under plain vitest), which is a real design decision on its own, not a one-line
  addition to a security fix already in flight.
- **Bound `faviconCache`?** Not in this fix. Its own comment already calls the unbounded,
  process-lifetime cache a deliberate "v0, revisit later" choice, made before this review and
  orthogonal to it -- reaching a private address was never something the cache made worse or
  better. Revisiting a sizing decision inside a branch whose job is a security fix is exactly the
  scope creep `CLAUDE.md` Rule 4 warns about.

**[`grant-prompt-render.ts`](grant-prompt-render.ts) — every pattern is rendered from the parsed
form, never a second guess at the raw string (R2-01/AR-05).** The original `hostFromPattern` here
split a pattern on `pattern.lastIndexOf(':')` and treated everything before it as the host --
a different, weaker set of rules than `hostSpecKind` (`../broker/policy/connect-patterns.ts`),
the grammar the runtime matcher actually uses to decide what a pattern authorises. The two
disagreeing was not a style issue: it is why `'*:443'` used to render as a narrow, literal
hostname called `"*"` (the old `isUnlimited` compared the whole pattern against the literal
string `"*:*"`) while the matcher itself treated a bare `'*'` host as reachable to any public
address regardless of its paired port, and why a host declared on several ports rendered
identically to one declared on a single port (`namedHostsPhrase` discarded the port half of every
pattern entirely). Parsing every pattern through the real grammar once, here, fixed both
divergences at their shared root rather than patching `isUnlimited` and `namedHostsPhrase`
separately, which would have left the underlying two-parsers problem in place for the next
person to trip over the same way (code-guidelines.md Rule 3).

**[`grant-prompt-render.ts`](grant-prompt-render.ts) — `formatOriginForDisplay` elides a long
host from the LEFT, and deliberately never tries to compute the registrable domain (A115,
T25).** `accounts.google.com.attacker.example` reads reassuringly left-to-right; the label that
actually decides authority, `attacker.example`, sits at the far right, exactly where a narrow or
truncated dialog is least likely to show it. The obvious-looking fix — show the registrable
domain (eTLD+1) prominently — needs a public suffix list this repo does not depend on, and a
naive "last two labels" guess is wrong for `example.co.uk` in the direction that matters (it
would emphasise `co.uk` and hide the real registrant). Adding that dependency is a stop
condition for this run, so it is parked as **A142** rather than added; this fix is the no-
dependency floor instead.

- **A plain character count, not a DNS-aware truncation.** `MAX_DISPLAYED_HOST_LENGTH` is 24 --
  roughly the length of a short, ordinary hostname (`accounts.google.com` itself is 20
  characters) plus a small margin, so an app's real host is essentially never elided on its own
  account. Padding a real brand name into a longer confusable is what pushes the total past 24,
  not anything about the shape of the string. The `example.co.uk`/bare-`example.com` test cases
  exist specifically to prove the rule is not accidentally tuned to `.com` or to any particular
  label count -- it never looks at labels at all, only length.
- **Elide the HOST[:port] only; the scheme is never touched or counted.** The scheme carries no
  authority information (it cannot be misread as a brand), so spending elision budget on it
  would only shorten the part that matters. `https://` always survives intact.
- **A naive forward-to-the-next-dot "clean label boundary" idea was tried and rejected.**
  Snapping the cut point to the next `.` after the raw character count reads better when nothing
  else changes, but the distance it skips depends on incidental length elsewhere in the string --
  appending a port was enough, in testing, to make it skip an entire label it should have kept
  visible. A plain character-count cut, with only a single conditional strip of one leading dot
  for cosmetics, cannot do that: it always keeps exactly the tail it is told to keep.
- **The same elided string is used for BOTH `title` and `detail`'s first line, not a fuller
  string in one and a shorter one in the other.** `detail` wraps in a native message box; `title`
  does not, and per A127 may not render at all on some platforms. Showing the full,
  un-elided origin in `detail` and relying on wrapping was considered and rejected for exactly
  that asymmetry -- it would leave `title`, wherever it *does* render, showing a different (and
  unprotected) string from `detail`. Using one function for both keeps them saying the same
  thing on every platform, whichever field survives.
- **A127's core fix -- the origin duplicated into `detail`, a field Electron does not document as
  ever being dropped -- predates this lane** (already present as `AR-01` before A115 was filed).
  This change does not alter that mechanism; it only hardens the string both fields now show.
  A127 stays open on its own remaining term: no macOS machine has confirmed the platform claim
  that motivated it, so "the title is not reliably shown" remains reasoned, not measured.
- **Not done, and named so nobody re-derives it as new:** no attempt to mark the origin line as
  "not a name you typed" beyond the contrast already created by the very next line (`Claims to
  be "<name>"`). A dedicated label (`Website: ...`) was considered; left out as presentation
  polish outside this lane's security floor, not as an oversight.

**[`grant-prompt-render.ts`](grant-prompt-render.ts) — `tcp.listen`/`udp.bind` now carry the
"distinct, more serious prompt" `manifest.ts`'s own doc comment on `TcpCapability.listen`
promises, and `capability-api.md`'s open item 1 requires (A134).** Before this fix,
`describeCapabilityGrant` rendered a listening grant as a plain `warning: false` row --
`"Accept incoming connections on port 6881-6889"` sat next to `"Connect to weather.example"`
with no visual or textual distinction, even though the contract already commits to asking these
two questions differently. **The contract's reasoning was checked, not assumed correct**: listening
means the network reaches the app -- anything on the local network, and anything on the internet
if the port is forwarded, for an unsigned app a person merely visited -- which is categorically
different from the app reaching out. Fixed by giving `tcp.listen`/`udp.bind` `warning: true`
unconditionally, plus an `explanation` naming the actual exposure, using the exact mechanism
`describeConnectCapability`'s wildcard-host branch already uses for the same purpose (Rule 3: one
vocabulary, not two). **Unconditional, not breadth-scaled:** unlike a connect grant, there is no
narrow case to distinguish -- a listen pattern can never be `"*"` (rejected at manifest validation)
and every declared port range carries the same shape of risk, the same reasoning
`describeRollbackChoice` already uses for its own unconditional `warning: true`.
**Tcp and udp get their own, deliberately different, sentences** ("can connect to this app" vs
"can send this app data") rather than one shared string with the noun swapped -- matching this
file's existing rule that two capabilities must never share a rendered sentence
(see the udp.send/tcp.connect distinctness test already in this suite).
**Two warned rows in one dialog do not collapse into one** (checked directly: an app declaring
both `https.connect: ["*:*"]` and `tcp.listen`): `describeCapabilitySet`'s per-row rendering
(above) already means each row keeps its own message and explanation regardless of how many
other rows are also warned -- the outer `warning` boolean is only ever an OR over the rows, never
a replacement for what each row says on its own line. Nothing needed to change here; a test now
pins that this stays true.

**[`grant-prompt-render.ts`](grant-prompt-render.ts) — "and N other sites" now warns past 10
others, closing the gap the sentence had no upper bound on (A133).** The count was always
honest; the question the finding raised was whether the sentence stayed a fact a person could
weigh at any size, and past some point it does not -- "and 4,271 other sites" is closer in kind
to an unlimited grant than to "a few named sites", and nothing said so.

**Why 10, not some other round number.** The owner's own worked example (`d-0027`) calibrates
the low end at 3 ("reads as intended"). The threshold is set at the point the rendered count
itself crosses from a single-digit, itemisable quantity into a double-digit one -- English marks
the same boundary in its own vocabulary, naming small counts individually ("a few", "several")
and reaching for a magnitude word ("dozens", "many") once a count passes nine. That gives a
checkable, language-native inflection point rather than a number chosen to fit a target string.
**This is presentation, not policy, and the owner may retune `MANY_OTHER_HOSTS_THRESHOLD` freely**
-- nothing downstream depends on the specific value 10; only on there being *some* value.

**What happens past the threshold is the wildcard-host mechanism, reused rather than
reinvented:** `warning: true`, a fixed headline (`"⚠ Connect to a large number of sites"`, not
the specific hosts), and an `explanation` that keeps the true count and the first host rather
than replacing them with a vaguer word -- so the summary is simultaneously "this is too many to
weigh" and, for anyone who wants it, the honest number. **Considered and rejected:** naming more
than one host before counting (does not address the actual problem -- ten spelled-out hostnames
crowd a dialog exactly as much as a large integer fails to inform one) and a details expander
(rejected by name for this exact surface, `D-0004`).

**[`install-consent.ts`](install-consent.ts) — "once per origin, ever" (A139) is derived from the
grant ledger's own hydration, not tracked as a second piece of state.** `requestInstallConsent`
could have kept its own persisted "was this origin ever asked" flag. It does not, because
`GrantLedger.registerApp`'s existing `grantsHydrated` mechanism already restores every still-valid
persisted grant into the live ledger, checked against the manifest `app-install.ts` just fetched,
before this function ever runs -- so an origin accepted on any earlier visit, this session or a
past one, already holds a live grant for its declared capabilities by the time this checks
`broker.app.grants(origin)`. A second flag recording the same fact would be exactly the Rule-3
duplicate this codebase keeps naming and then finding later.

**The one case that derivation cannot cover, named rather than quietly accepted: a fully DECLINED
visit.** All-or-nothing (`A138`) means declining creates no grant at all, and the ledger has no
concept of "asked, and the answer was no" -- only of what was actually granted. So a declined
origin looks identical to a never-visited one on the next visit, and is asked again. Filed as
`A145` (`docs/open-questions.md`) rather than fixed here: closing it needs either a new persisted
"decision made" marker (a real addition to `LedgerStorage`'s shape, which touches every
implementation of it) or an owner decision that repeated friction for a repeatedly-declined app is
acceptable, or even desirable -- neither is this lane's call to make alone.

**[`app-install.ts`](app-install.ts) — what "before the app's own scripts run" actually means
here, stated precisely because the two readings differ.** `requestInstallConsent` is awaited
inside `installFromHint`'s own `'installed'` branch, so the dialog is fully resolved -- shown,
answered, every accepted capability granted -- before `installFromHint`'s promise ever resolves.
That is the strongest guarantee available here: nothing downstream of this function's return can
observe an unconsented app. **It is NOT "before this page's scripts execute", and the difference
matters more than it first looks** -- see `open-questions.md` A146.

The production caller now exists ([`manifest-hint.ts`](manifest-hint.ts), the discovery trigger).
It fires when the page's own delivered HTML is parsed, which means **the page is already running
by the time consent is asked.** An app's first-visit script can therefore call a capability while
the dialog is still on screen, and get `'denied'` -- which is precisely the race owner decision
`d-0025` exists to remove. On every later visit there is no race at all: the grant is already
held, so the app starts with a decided answer. The gap is first visit only, and it is real.

Closing it properly means holding the page before its scripts run, which is a change to how a
tab navigates rather than anything this file can do. Filed rather than improvised.

**[`app-install-subsystem.ts`](app-install-subsystem.ts) — published even though nothing calls it,
same honest state as `request-grant-subsystem.ts`'s own `ctx.requestGrant`.** Building the
subsystem now, rather than leaving it for S4-2 to construct its own `AppInstallDeps`, keeps one
definition of "how installFromHint is wired for real" (the broker, the loader, and the real
dialog together) instead of two call sites that could quietly drift -- e.g. one remembering to
pass `consent` and one forgetting it, silently degrading to "every app installs with nothing
granted" with no error anywhere.

**[`request-grant.ts`](request-grant.ts) — re-reads the manifest, and re-runs
`decideGrantRequest`, between `consent()` returning and `broker.grant()` committing (`A153`,
`docs/open-questions.md`).** `consent()` can await a real dialog for up to 120 seconds (`A140`),
and `installFromHint` (`./app-install.ts`) can re-register a narrower manifest for the same
origin at any point during that wait -- a page can trigger this by reloading itself, which
re-runs its `<link rel="orivon-manifest">` hint (`src/preload/manifest-hint.ts`). Without the
re-check, `broker.grant()` committed a decision computed against a manifest that might no longer
be the one in force, and `GrantLedger.grant()` has no invariant of its own to catch that --
capability-api.md's design rule 4 ("a grant can never exceed the manifest") was true only at the
moment `decideGrantRequest` first ran, not at the moment the grant actually landed. The re-check
uses the EXACT patterns already shown to the person (`decision.patterns`), never a fresh request,
so accepting means exactly what was asked and nothing wider ever slips through on a re-read that
happens to be more permissive. **Deliberately not also serialised through `withOriginQueue`**:
the re-check alone closes the security hole outright, and a queue would only change TIMING --
making one origin's grant dialog wait behind another's install (which can itself show a dialog,
another up to 120 seconds) rather than closing anything the re-check leaves open. AI
recommendation, not an owner decision; see `A153`.

**[`grant-changed-capabilities.ts`](grant-changed-capabilities.ts) — extracted so
`./install-consent.ts` and `./update-outcomes.ts` cannot each get "was this capability's
authority actually different" wrong in a different way (`A156`, `A157`).** `broker.grant()`
(`src/broker/index.ts`) always mints a fresh `GrantId` and tears down every live handle under the
grant it replaces -- correct, and deliberately tested, for a REAL authority change (`A84`), but
both call sites used to call it unconditionally for every capability in their own "capabilities
to grant" list, including ones already held with an identical pattern set. The concrete harm:
accepting an update that only adds `fs` could silently kill an open, unrelated `tcp.connect`
socket, because the update's own capability list still named `tcp.connect` even though nothing
about it had changed. Comparing pattern sets ORDER-INDEPENDENTLY matters here specifically --
a manifest re-declaring the same patterns in a different order must read as unchanged, not as a
widening that happens to net out to the same set.

**[`install-consent.ts`](install-consent.ts) — bound 2 is now `.every`, not `.some` (`A157`).**
`app.requestGrant` (`./request-grant.ts`) is a second door to a grant, reachable while a page's
own scripts are already running (`A146`), and `registerApp` runs before this function in
`app-install.ts`'s own `finishInstall` -- so an app could call `requestGrant` for exactly one of
its declared capabilities before this check ever sees it. The old `.some` read "any declared
capability already held" as "already asked", which is true when this function granted
everything, but also true after that one out-of-band grant -- and skipping the WHOLE dialog then
permanently withheld every other declared capability, silently. `.every` only skips once nothing
declared is left unheld. This is still an INFERENCE from held grants, not a record of "asked, and
here is the answer" -- the same honest limit `A145` already named for the decline case -- and
`A157` parks the real fix (a persisted consent-decision marker, or an owner decision that the
inference is an acceptable floor) rather than deciding it here.
