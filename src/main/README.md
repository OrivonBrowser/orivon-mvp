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

**[`grant-prompt-render.ts`](grant-prompt-render.ts) — `formatOriginForDisplay` keeps only the
HOST's last three dot-separated labels, and shows the whole host at three or fewer (A115, T25,
owner decision 2026-09-14).** `accounts.google.com.attacker.example` reads reassuringly
left-to-right; the label that actually decides authority, `attacker.example`, sits at the far
right, exactly where a narrow or truncated dialog is least likely to show it. In the owner's own
words: always show "the sub domain, the domain name, and the domain name level 1 (the www, the
google and the .com)".

- **This is the second mechanism this function has used, not the first — history, not current
  behaviour.** The original fix (A115, landed 2026-09-13) elided from the LEFT by a plain
  24-character count (`MAX_DISPLAYED_HOST_LENGTH`), never looking at labels at all. It defended
  the same attack and is why the `example.co.uk`/bare-`example.com` test cases exist — proving
  the old rule was not accidentally tuned to `.com` or to any particular label count. The owner's
  2026-09-14 decision **replaces** it outright with a label count, not an addition to it: no
  origin is elided by both rules layered together, and the character-count constant is gone from
  the source.
- **Closes A142 without the public-suffix-list dependency that entry was parked for.** A142's
  concern was real: the obvious-looking fix — show the registrable domain (eTLD+1) prominently —
  needs a public suffix list this repo does not depend on, and a naive "last two labels" guess is
  wrong for `example.co.uk` in the direction that matters (it would emphasise `co.uk` and hide
  the real registrant). **Three labels gets `example.co.uk` right by construction, with no list
  to consult:** it has exactly three labels, so the whole-host branch shows it unchanged, and
  `www.example.co.uk` reduces to `example.co.uk` — the same three labels — not to `co.uk`. The
  same reasoning covers every two-label public suffix this way (`.co.jp`, `.org.uk`, and the
  rest): the count only ever needs to be right about *how many* labels to keep, never about
  *which* labels form a registry-controlled suffix.
- **A residual shape three labels does NOT get right, found while verifying the above and filed
  rather than silently accepted: multi-label PRIVATE suffixes, the kind cloud/PaaS platforms
  register in the Public Suffix List's private section.** `s3.amazonaws.com` is itself a fixed
  three-label suffix (not a ccTLD structure), and some AWS regional compute suffixes run to four
  labels (`ap-northeast-1.compute.amazonaws.com`) — confirmed against the live list, not assumed.
  A bucket or instance name sits to the LEFT of a suffix that long, so `bucket-name.s3.amazonaws.
  com` shows as `...s3.amazonaws.com` under this rule: a real, legitimate-looking AWS domain,
  with the tenant-controlled label — which can itself carry a same-shaped confusable, since S3
  bucket names may contain literal dots — dropped entirely rather than merely shortened. Filed as
  its own entry rather than folded into A142, because a public suffix list would not fully close
  this one either: it tells you *where* a suffix ends, but this file's fixed three-label count
  cannot follow a boundary that moves per platform the way A142's ccTLD case needed it to.
- **A plain label count, not a character count.** `DISPLAYED_LABEL_COUNT` is 3, and the function
  never measures string length at all. A host that is long but exactly three labels
  (`a-perfectly-ordinary-but-very-long-subdomain.example.com`) is now shown in full — a real,
  intentional behaviour change from the 24-character rule, which elided it purely for length.
- **An IP literal is opaque to this rule, on purpose.** `net.isIP` (after stripping IPv6's own
  bracket syntax) decides this before any label splitting happens, and a positive match returns
  the origin unchanged. An IP address is not a registrable-domain hierarchy — cutting it would
  change which machine it names, not shorten a cosmetic prefix, so it is exempted rather than
  merely handled gracefully by the label logic (which would mis-split an IPv4 literal's own dots
  as if they were DNS labels).
- **A trailing dot (an explicit FQDN root, `example.com.`) is stripped before counting, and
  dropped rather than restored on an elided tail.** It carries no identity information, so
  keeping it out of the label count is correct, and re-attaching it to a shortened display would
  only add a character nobody needs — the same treatment `www` already gets.
- **Elide the HOST only; the scheme is never touched, and a non-default port is reattached after
  the label cut, never counted as part of it.** The scheme carries no authority information (it
  cannot be misread as a brand), so it always survives intact. The port belongs to the host and
  must survive too — under the old character-count rule a port's own digits could eat into the
  budget and drop a whole extra label (`accounts.google.com.attacker.example:8443` used to render
  as `...attacker.example:8443`, silently losing "com" as well as the count); counting labels
  first and appending the port afterward means the port's length can never change which labels
  survive.
- **The same elided string is used for BOTH `title` and `detail` (as of 2026-09-14, `detail`'s
  LAST line -- see the entry below), not a fuller string in one and a shorter one in the
  other.** `detail` wraps in a native message box; `title` does not, and per A127 may not render
  at all on some platforms. Showing the full, un-elided origin in `detail` and relying on
  wrapping was considered and rejected for exactly that asymmetry -- it would leave `title`,
  wherever it *does* render, showing a different (and unprotected) string from `detail`. Using
  one function for both keeps them saying the same thing on every platform, whichever field
  survives.
- **A127's core fix -- the origin duplicated into `detail`, a field Electron does not document as
  ever being dropped -- predates this lane** (already present as `AR-01` before A115 was filed).
  This change does not alter that mechanism; it only changes the rule both fields now apply.
  A127 stays open on its own remaining term: no macOS machine has confirmed the platform claim
  that motivated it, so "the title is not reliably shown" remains reasoned, not measured.
- **Not done, and named so nobody re-derives it as new:** no attempt to mark the origin line as
  "not a name you typed" beyond the contrast already created by its own isolation as the last
  line (see the address-last entry below). A dedicated label (`Website: ...`) was considered;
  left out as presentation polish outside this lane's security floor, not as an oversight.

**[`grant-prompt-render.ts`](grant-prompt-render.ts) -- the origin moved to the LAST line of
`detail`, and the claimed name to the FIRST, across every dialog that shows one (owner decision
2026-09-14, lane `stream/shell-07-address-last`).** Before this change every dialog in this file
put the origin first and `Claims to be "<name>"` immediately under it -- the exact shape the
owner flagged: `manifest.name` is app-chosen text a scam app can set to anything, and a person
reading quickly took in the address, then read the friendly name right below it, and stopped
there. The address is the one line in this box an app cannot fake; the name is the one line an
app fully controls. Putting the fakeable line last, right before the buttons, is exactly backward
from what the box should do.

**The fix is a straight reordering, not a new field or a duplicate:** `detail`'s lines become
claim, then whatever content that dialog already carried (a capability's `explanation`, a
manifest's capability rows, an update notice), then the origin -- for every one of the four
functions that build a `detail` string (`describeGrantRequest`, the shared `describeCapabilitySet`
behind `describeInstallConsent`/`describeCapabilityPrompt`, `describeReconsent`,
`describeRollbackChoice`). `title` is untouched -- still the origin, per AR-01's own reasoning
that Electron may not render `title` at all, so `detail` must carry it too, just now at its other
end.

**Where the claim goes was a real choice, not the only way to satisfy "address last"; both are
2026-09-14, AI recommendation.** Two shapes both put the origin last: claim-then-content-then-
origin (what shipped), or content-then-claim-then-origin, with the claim moved down to sit
immediately above the address instead of at the top. The second was rejected: it recreates the
exact adjacency this lane exists to remove, just shifted one line down and still directly beside
the address at the moment that matters most -- the two lines a hurried reader takes in together
right before clicking a button. Putting the claim at the top instead means every capability row
or notice sits *between* the fakeable name and the real address, so the address arrives alone,
with nothing app-chosen immediately next to it, exactly where AR-03's own rule (never let
`manifest.name` share a line with Orivon's words) already argues attention should stay clean.
Read as a whole, the new order also narrates better: state the (unverified) claim, say what it
wants or what changed, then ground it in the one verifiable fact right before the decision.

**Every dialog that shows an origin moved consistently, not only the install prompt (Rule 3).**
`describeCapabilityPrompt` and `describeInstallConsent` share `describeCapabilitySet`'s one
assembly point, so both moved together by construction. `describeReconsent` and
`describeRollbackChoice` build their own `detail` arrays directly (they render no capability
rows) and were each updated by hand to the same claim-first, address-last shape -- checked
directly in `grant-prompt-render.test.ts`, which had no dedicated tests for either function
before this lane; both now do.

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
**Correction, coordinator review 2026-09-14: "two warned rows in one dialog do not collapse into
one" was true of the pair tested (`https.connect: ["*:*"]` + `tcp.listen`) and false in general.**
The flagship's real manifest -- `tcp.connect: ["*:*"]` + `tcp.listen` + `udp.bind` + `udp.send:
["*:*"]` + `fs` -- rendered 4 of 5 rows warned, with `"⚠ Unlimited network access"` appearing
TWICE (from `tcp.connect` and `udp.send`, each with its own explanation underneath). Read cold,
a repeated headline looks like a rendering bug, and a wall of four identical markers stops
telling the reader anything -- A100's exit criterion is that unlimited looks unmistakably
different from narrow, not that everything serious looks the same as everything else serious.
Neither problem was reachable by the tests this lane had, all of which declared at most one
warned axis at a time.

**Fixed by two merges inside `describeCapabilitySet`, both removing REDUNDANT rows rather than
TRUE ones.** `mergeRowsWithIdenticalMessage` collapses any two rows that render the identical
headline into one, unioning their explanations -- general on purpose, so it fires for whichever
capabilities happen to coincide, not only `tcp.connect`/`udp.send`. `describeInboundAccess`
merges `tcp.listen` and `udp.bind` into one row whenever a single request names both, because a
real P2P app declares both for the SAME reason (one port range, TCP peer connections and UDP
DHT/exchange) -- rendering them as two separately-scary rows states one fact ("other computers
can reach this device") twice. Either capability alone still renders through
`describeCapabilityGrant`'s own unmerged case exactly as before, including in the settings
permissions list (`../permissions.ts`), which needs each grant on its own revocable row and
never calls the merged path. After both merges the flagship shows exactly two warned rows, not
four -- one per DISTINCT kind of breadth it actually declares (it can reach anywhere outbound,
and it can be reached from anywhere inbound), never a third or fourth restating one of those two.

**Considered and rejected: a second, lower-severity marker for `tcp.listen`/`udp.bind`, so
"unlimited" and "opens a door" would read as different tiers of the same scale.** Rejected
because they are not degrees of the same risk -- an app choosing where it connects and a device
accepting connections from strangers are different KINDS of exposure, not one being milder than
the other, and grading one below the other would misstate that rather than declutter it. The
actual defect was redundancy (one fact stated on 2-4 rows), not that two genuinely different
facts both deserve a visible marker; removing the redundancy left exactly as many markers as
there are distinct facts, which is what A100 asks for in the first place.

**[`grant-prompt-render.ts`](grant-prompt-render.ts) — "and N other sites" now warns only once
the declared host count reaches half of `MAX_PATTERNS`, closing the gap the sentence had no
upper bound on (A133).** The count was always honest; the question the finding raised was
whether the sentence stayed a fact a person could weigh at any size, and past some point it does
not -- "and 4,271 other sites" is closer in kind to an unlimited grant than to "a few named
sites", and nothing said so.

**Correction, coordinator review 2026-09-14: the first threshold (10 OTHER hosts) was wrong, not
just unproven.** It was reasoned from where English shifts from naming small counts individually
to a magnitude word ("dozens", "many") -- calibrated against the owner's own worked example
(`d-0027`, 3 others "reads as intended"), but never checked against an ordinary app with a
longer, still-narrow list. A 12-feed reader (`nytimes.com`, `bbc.com`, `reuters.com`, ...) is
exactly that: twelve individually meaningful, curated destinations, narrow by any sensible
reading -- and it tripped the warning, because 11 crosses from one digit to two just as easily
whether the list behind it is curated or not. Single-digit-vs-double-digit measures how a number
*reads*, which turns out not to be what determines whether a host list is actually broad.

**Re-anchored on something a host count can be compared against instead: `MAX_PATTERNS`, the
same enforced ceiling (`loader/manifest-capabilities.ts`) on how many patterns one capability's
array may ever declare, already imported here for the wildcard-port check.** The threshold is
now `MAX_PATTERNS / 2` -- 128 at today's ceiling of 256. A feed reader's dozen sources clears it
by more than 10x; so would a large CDN allowlist of several dozen hosts. What trips it is a
manifest naming HALF of the total address space the format permits it to name at all, which is
the point past which a list has stopped being a materially narrower declaration than not naming
any hosts -- close enough to the structural maximum that individual names have stopped doing
useful work for the reader. **This is presentation, not policy, and the owner may retune
`MANY_HOSTS_THRESHOLD` freely** -- nothing downstream depends on the specific fraction (half);
only on the threshold moving with `MAX_PATTERNS` rather than drifting from it, and on there being
*some* value that a plausible ordinary app cannot reach by accident.

**What happens past the threshold is unchanged from the first version:** the wildcard-host
mechanism, reused rather than reinvented -- `warning: true`, a fixed headline
(`"⚠ Connect to a large number of sites"`, not the specific hosts), and an `explanation` that
keeps the true count and the first host rather than replacing them with a vaguer word.
**Considered and rejected:** naming more than one host before counting (does not address the
actual problem -- spelled-out hostnames crowd a dialog exactly as much as a large integer fails
to inform one), a details expander (rejected by name for this exact surface, `D-0004`), and
counting distinct registrable domains instead of raw hosts (the coordinator's own suggestion,
worth recording why it was not built: computing a registrable domain as a value to count, not
just a string to display, still needs a public suffix list this repo does not depend on --
`formatOriginForDisplay`'s label-count rule (A142, resolved) answers "how much of this host do I
show", never "what is this host's registrable domain", so it settles no part of this different
question -- and it would not by itself have saved the feed-reader case anyway, since twelve
different news outlets are twelve different registrable domains; the fix that actually matters
here is the threshold's size, not the unit it counts in).

**[`install-consent.ts`](install-consent.ts) — "once per origin, ever" (A139) is derived from the
grant ledger's own hydration, not tracked as a second piece of state.** `requestInstallConsent`
could have kept its own persisted "was this origin ever asked" flag. It does not, because
`GrantLedger.registerApp`'s existing `grantsHydrated` mechanism already restores every still-valid
persisted grant into the live ledger, checked against the manifest `app-install.ts` just fetched,
before this function ever runs -- so an origin accepted on any earlier visit, this session or a
past one, already holds a live grant for its declared capabilities by the time this checks
`broker.app.grants(origin)`. A second flag recording the same fact would be exactly the Rule-3
duplicate this codebase keeps naming and then finding later.

**The one case derivation could not cover on its own -- a fully DECLINED visit -- is now a real
persisted record, not an inference (`A145`, resolved 2026-09-14).** All-or-nothing (`A138`) means
declining creates no grant at all, so there was nothing for `grantsHydrated` to derive an answer
from. `requestInstallConsent` now checks `broker.declinedCapabilitiesFor(origin)` between the
"already held" check above and showing the dialog: a manifest whose declared set is fully covered
by what was declined stays suppressed, and a manifest asking for something NOT in that set (a
widen) is asked again. `GrantLedger.recordDeclinedConsent`/`clearDeclinedConsent`
(`src/broker/grants/declined-consent.ts`) are the write side -- the accept branch clears the
record, so an old "no" cannot outlive a later "yes". This is ADVISORY ONLY: it can suppress this
dialog, never grant anything, and `app.requestGrant` (`./request-grant.ts`) remains a completely
independent, unaffected path for an app that offers its own in-app "connect" affordance. Whether a
LATER-NARROWED manifest should still be asked again is an AI recommendation, explicitly retunable
-- see `A145`'s own resolution block for the argument either way.

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
here is the answer" -- the honest limit `A145` named for the decline case is now CLOSED there
(a real persisted decline record, `declined-consent.ts`), but deliberately NOT extended to this
accept-side inference: the owner's decision behind that fix was specifically "remember a no", and
a live `Grant` is already stronger evidence of "asked and agreed" than a separate marker recording
the question would be. `A157` still parks whether this residual inference is an acceptable floor
or needs its own persisted marker -- see that entry's 2026-09-14 update.

**[`install-consent.ts`](install-consent.ts) / [`grant-prompt-choice.ts`](grant-prompt-choice.ts) /
[`install-consent-prompt.ts`](install-consent-prompt.ts) — A138's `'per-capability'` path: what
"outstanding" replaces, why the real dialog is a staged native sequence rather than a custom
window, and what a partial decline means for the remembered-no record.**

*Why `requestInstallConsent`'s two gates became one filter.* Before this, "already asked" was two
separate whole-set checks: skip if EVERY declared capability is held, else skip if EVERY declared
capability is declined. That was sound only because an all-or-nothing decision always covers the
WHOLE declared set at once — accept grants everything, decline records everything — so `held` and
`declined` could never both be non-empty, non-overlapping subsets of the same request. A
`'per-capability'` accept-some-refuse-some decision makes exactly that mixed state reachable: e.g.
`held = [tcp.connect]`, `declined = [fs]`. Neither old whole-set check would have fired, so the
dialog would have shown again for the full set every restart — asking again about a capability
already decided in both directions. `outstanding` (capabilities covered by NEITHER `held` NOR
`declined`) is the generalisation: proven, not assumed, to collapse back to the exact old
behaviour whenever the mixed state cannot occur (install-consent-per-capability.test.ts's own
restart suite, plus every pre-existing install-consent.test.ts case, unmodified and still green).

*Why the all-or-nothing dialog still shows the WHOLE declared set, not `outstanding`, while the
per-capability one asks only about `outstanding`.* `A157`'s own test fixed this asymmetry once
already: a person choosing all-or-nothing must see the complete picture even when part of it is
already held from an out-of-band `app.requestGrant` call, because `grantChangedCapabilities`
already skips re-granting anything unchanged — showing the narrower `outstanding` set there would
under-inform the person about what the app actually holds. Per-capability has no such reason to
over-ask: each capability gets its own explicit yes/no, so one already decided (held or declined)
has nothing left to ask.

*Why the real per-capability surface is a staged sequence of native dialogs, not a window Orivon
renders itself.* Three shapes were on the table (the lane's own brief named them): a plain
sequence of independent native dialogs, a self-rendered checkbox-list window, or something staged.
A plain sequence was rejected for reproducing exactly the fatigue the combined dialog (`A139`) was
built to remove, and for never showing the whole request before any one part is decided. A
self-rendered window is the only shape with a true checkbox list, but it is a new privileged
surface — its own `webPreferences`, its own CSP, load-bearing the same way the chrome view's is
(this file's own §Design notes on that view) — for a feature this lane's brief itself frames as a
genuine, still-open design question rather than a settled requirement; building it now would be
spending that care before the owner has seen the cheaper option work. The staged shape costs one
extra click for the common cases (`Allow all` / `Deny all`, one dialog, same cost as today) and
keeps the WHOLE request visible on every screen of the individual-choice path
(`describeCapabilityChoice`, one screen per capability, marking the current row and everything
this same sequence already decided) — the one property a plain sequence cannot offer at all, at
zero new-surface cost. **AI recommendation, not an owner decision** — flagged in the PR as
`needs-owner-decision`; a self-rendered window remains the better long-term answer if the owner
wants a true checkbox list once this surface proves out.

*What a partial acceptance does to the remembered-decline record.* The record was designed
(`A145`) as one list per origin, replaced wholesale on every decision. A partial decision cannot
use wholesale replace without erasing an unrelated earlier decline: if a person declined `fs`
last week and today accepts `tcp.connect` (a different, newly-declared capability), replacing the
whole record with just this round's answer would un-decline `fs` nobody revisited. Because
`outstanding` already excludes anything in the old `declined` set by construction, nothing this
round accepts or refuses was ever a member of it — so the new record is simply the old one plus
exactly this round's fresh refusals, never a subtraction. An accept is never separately recorded;
`grantsHydrated`'s own derivation (`A139`, above) already covers it once the grant lands.
