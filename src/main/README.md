# `src/main/`: the Electron main process

**What lives here.** The browser shell: the window, tab management, the omnibox, shell IPC, and
the subsystem registry every other stream plugs into.

**What it depends on.** `electron`, [`src/contracts/`](../contracts/).

**What it must never import.** [`src/renderer/`](../renderer/) code. The main process and the
renderer communicate over IPC, never by sharing modules.

**Owner stream.** `shell`, build step 1, **done**. Maintenance only; other streams add
themselves via `subsystems.ts` rather than editing here.

| File | Responsibility |
|---|---|
| `index.ts` | Entry point. Runs the subsystem registry, then creates the window |
| `registry.ts` | `Subsystem`, and the two phase runners. Unit tested, no Electron at runtime |
| `subsystems.ts` | **The append point.** Adding a subsystem is two lines here |
| `window.ts` | Composes the frameless `BaseWindow`: chrome view on top, active tab view below |
| `tabs.ts` | `TabManager`: creating, switching, closing, bounds, and deciding when a navigation must repartition a tab |
| `tab-view.ts` | Pure: builds one tab's `WebContentsView` and derives its session partition from a URL |
| `tab-types.ts` | The wire-format types (`TabState`, `TabsSnapshot`, `ShellState`, `Bounds`) pushed to the chrome UI |
| `ipc.ts` | Shell IPC channels between the chrome view and main |
| `omnibox.ts` | Address-bar input: URL or search. Unit tested |
| `delivery-provenance.ts` | S4-6, `ADR-0007`: whether the active tab is being served from Orivon's own pinned cache, the address-bar dot's one truthful signal |
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
main to it avoids a two-format build for no gain. An ESM main process does work, verified
against Electron 44, if a reason to switch ever appears.

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
off-machine. Only this machine is in scope. `src/main/tests/favicon.test.ts` holds both halves:
what is allowed, and the obfuscated-loopback spellings that stay refused to a public page.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**[`index.ts`](index.ts): do not add `ozone-platform: x11`.** It makes things strictly worse:
the GPU process segfaults under XWayland on this machine (`exit_code=139`) and the window stops
rendering at all. It looks like a fix for "no window ever appears", but that symptom was never
about display selection; see
[`window.ts`](window.ts)'s `showOnce` comment for the actual root cause and fix (`ready-to-show`
unreliable when loading from the dev server).

**[`tabs.ts`](tabs.ts) is split three ways: constructing and partitioning a view, managing the
collection of tabs, and the shapes pushed to the chrome UI.** A tab's partition is computed on
every path that can change its origin, not only in `createTab()`: typing a URL or the
dashboard's navigate command goes through `TabManager.navigate()`, which swaps in a fresh
`WebContentsView` (`repartitionView()`) whenever the target's origin differs from the tab's
current partition. Electron fixes a partition at construction, so a live tab can only change
session by replacing its view outright, preserving the tab's id, position and active state. The
pure parts live apart so `tabs.ts` stays under Rule 2's 500 lines: `tab-view.ts` (view
construction and origin→partition derivation, no `TabManager` state) and `tab-types.ts` (the
wire-format interfaces, no logic at all), both re-exported from `tabs.ts`. **Trap:** a
deliberately swapped-out old view's own `'destroyed'` listener must be stripped *before*
`close()` is called, or the teardown calls `forgetTab()` on a tab that is not closing;
`src/main/tests/tabs.test.ts` exercises this directly with a fake `webContents` that emits
`'destroyed'` synchronously from `close()`, the same way real Electron destruction can.

**[`tabs.ts`](tabs.ts): what `TabManager`'s `ctx: SubsystemContext` is for, and why one half
of it is unused.** `ctx.broker` is read by every `makeTabView` call site (`appTabArgsFor`,
ADR-0017) to decide the `fetch()`-routing flag. It stays `Broker | undefined`, so a run where
the broker subsystem is absent simply never sets the flag, the same fallback shape
`partitionForTarget` already has. `ctx.loader` is threaded through but `TabManager` reads it
nowhere: the discovery trigger ([`manifest-hint.ts`](manifest-hint.ts)) installs through the
published `ctx.installApp` instead. Anything that does read `ctx.loader` must treat it as
possibly absent: `loaderSubsystem` is not `critical`, unlike the broker.

**[`tabs.ts`](tabs.ts): every navigation that reaches a new origin repartitions the tab: a
typed URL, a redirect, a clicked link, a form submission or a script navigation (A108/A109).**
`wireView()`'s `did-navigate` handler calls `repartitionView()`, the same swap `navigate()` uses,
whenever the *committed* URL's origin differs from the tab's current partition.
`tab-view.ts`'s `partitionChanged` is the one comparison both paths use, so they can never
compute it two different ways.

**The residual: an early read in the old partition.** `did-navigate` fires only once a
navigation has already committed, and by then the new origin's page has already rendered once
inside the OLD partition and may already have read from it. This swap corrects the partition
going forward; it does not undo an early read. The stronger shape, `will-navigate`/`will-redirect`
with `preventDefault()` and a re-entry through the partition-aware path, catches it before commit,
but costs a fresh view and a lost navigation-history entry on every ordinary cross-origin link
click, not only a redirect. That earlier interception is an open question (A109), not built.

**Trap: the dashboard tab.** The
dashboard's own dev-mode URL is a real `http(s)` address, so treating its OWN first `did-navigate`
the same as an ordinary tab's would see partition `undefined` -> a real partition as an "origin
change" and repartition the dashboard into an app partition on its very first load. The handler
excludes `record.isDashboardTab` explicitly rather than relying on `partitionChanged` alone to
catch this case.

**[`permission-gate.ts`](permission-gate.ts): wired through `app.on('session-created', ...)`,
not a call inside `tab-view.ts`'s `makeTabView()`.** Electron fires that event exactly once for
every `Session` it ever instantiates in this process, `session.defaultSession`'s own creation
included, so one listener, attached before anything can create a session, reaches every future
`session.fromPartition(...)` call too, including ones no code here has written yet. A handler
installed only at `makeTabView`'s own call site would miss the default session (used by the
chrome UI and every rejected or dashboard-bound tab) and any session a later stream creates some
other way; enumerating today's known partitions once at startup would still miss a partition a
tab opens after that point, which is most of them: `partitionFor(origin)` sessions come into
being as tabs open, not at startup. The subsystem is listed first in `subsystems.ts`, ahead of
everything else, so its `beforeReady` attaches the listener before any other subsystem's own
`beforeReady` gets a chance to create a session.

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
(`update-check-runner.ts`'s `RELEASES_API`) or gated behind an app install
(`loader/install-origin.ts`, `loader/electron-fetch.ts`). A page's own `<link rel="icon">` is fully
attacker-controlled, so without a check `pickFaviconUrl` would hand `fetchFaviconDataUrl` a URL
pointing anywhere, whether `169.254.169.254`, a LAN admin panel or a localhost service, and the main
process would issue a real GET to it. `isSafeFaviconUrl` closes this the same way
`install-origin.ts` closes the equivalent gap for an app install: reuse `policy/address.ts`'s
`classifyAddress`/`isPublicUnicast` and `policy/origin.ts`'s `isLocalhostName` directly, and
`loader/electron-resolve.ts`'s `electronResolveHost` for the one case those cannot answer alone (a
hostname, which needs resolving before it can be classified), never a second implementation of
any of the three (code-guidelines.md Rule 3).

Three related questions, and the current answer to each:

- **Accept `http://` for a favicon at all?** No. `isSafeFaviconUrl` refuses it outright --
  refusing plaintext costs a real favicon nothing and closes a downgrade path from an https page.
  This lives in the fetch path, not in `pickFaviconUrl`: that function's own test asserts it still
  *selects* an `http://` candidate (picking a URL is not fetching one), so the refusal sits where
  the fetch actually happens.
- **Bound the number of favicon fetches one tab can drive?** Not bounded. `page-favicon-updated`
  can fire repeatedly and nothing caps it, but that is a resource-exhaustion question (T11b's
  shape) against what `isSafeFaviconUrl` allows through, which is only *public* hosts, not a T12
  address-reach question. Bounding it well needs new per-tab state in `tabs.ts` (which
  favicon.ts deliberately has no dependency on, so it stays importable under plain vitest), a
  design decision of its own.
- **Bound `faviconCache`?** Not bounded. Its own comment calls the unbounded, process-lifetime
  cache a deliberate "v0, revisit later" choice, and it is orthogonal to T12: reaching a private
  address is not something the cache makes worse or better.

**[`grant-prompt-render.ts`](grant-prompt-render.ts): every pattern is rendered from the parsed
form, never a second guess at the raw string.** Every pattern goes through `hostSpecKind`
(`../broker/policy/connect-patterns.ts`), the grammar the runtime matcher uses to decide what a
pattern authorises. A second, weaker parser here would let the prompt and the matcher disagree:
`'*:443'` would render as a narrow, literal hostname called `"*"` while the matcher treats a bare
`'*'` host as reachable to any public address regardless of its port, and a host declared on
several ports would render identically to one declared on a single port. One parser removes both
divergences at their shared root (code-guidelines.md Rule 3).

**[`grant-prompt-render.ts`](grant-prompt-render.ts): `formatOriginForDisplay` keeps only the
HOST's last three dot-separated labels, and shows the whole host at three or fewer (A115, T25).** `accounts.google.com.attacker.example` reads reassuringly
left-to-right; the label that actually decides authority, `attacker.example`, sits at the far
right, exactly where a narrow or truncated dialog is least likely to show it. The requirement is
to always show "the sub domain, the domain name, and the domain name level 1 (the www, the google
and the .com)".

- **No public suffix list needed (A142).** The obvious-looking fix, showing the registrable domain (eTLD+1) prominently,
  needs a public suffix list this repo does not depend on, and a naive "last two labels" guess is
  wrong for `example.co.uk` in the direction that matters (it would emphasise `co.uk` and hide
  the real registrant). **Three labels gets `example.co.uk` right by construction, with no list
  to consult:** it has exactly three labels, so the whole-host branch shows it unchanged, and
  `www.example.co.uk` reduces to `example.co.uk`, the same three labels, not to `co.uk`. The
  same reasoning covers every two-label public suffix this way (`.co.jp`, `.org.uk`, and the
  rest): the count only ever needs to be right about *how many* labels to keep, never about
  *which* labels form a registry-controlled suffix.
- **A residual three labels does NOT get right: multi-label PRIVATE suffixes, the kind cloud/PaaS platforms
  register in the Public Suffix List's private section.** `s3.amazonaws.com` is itself a fixed
  three-label suffix (not a ccTLD structure), and some AWS regional compute suffixes run to four
  labels (`ap-northeast-1.compute.amazonaws.com`), confirmed against the live list rather than assumed.
  A bucket or instance name sits to the LEFT of a suffix that long, so `bucket-name.s3.amazonaws.
  com` shows as `...s3.amazonaws.com` under this rule: a real, legitimate-looking AWS domain,
  with the tenant-controlled label, which can itself carry a same-shaped confusable, since S3
  bucket names may contain literal dots, dropped entirely rather than merely shortened. Tracked
  separately from A142, because a public suffix list would not fully close
  this one either: it tells you *where* a suffix ends, but this file's fixed three-label count
  cannot follow a boundary that moves per platform the way A142's ccTLD case needed it to.
- **A plain label count, not a character count.** `DISPLAYED_LABEL_COUNT` is 3, and the function
  never measures string length at all. A host that is long but exactly three labels
  (`a-perfectly-ordinary-but-very-long-subdomain.example.com`) is shown in full; length alone
  never elides anything.
- **An IP literal is opaque to this rule, on purpose.** `net.isIP` (after stripping IPv6's own
  bracket syntax) decides this before any label splitting happens, and a positive match returns
  the origin unchanged. An IP address is not a registrable-domain hierarchy, and cutting it would
  change which machine it names, not shorten a cosmetic prefix, so it is exempted rather than
  merely handled gracefully by the label logic (which would mis-split an IPv4 literal's own dots
  as if they were DNS labels).
- **A trailing dot (an explicit FQDN root, `example.com.`) is stripped before counting, and
  dropped rather than restored on an elided tail.** It carries no identity information, so
  keeping it out of the label count is correct, and re-attaching it to a shortened display would
  only add a character nobody needs, the same treatment `www` already gets.
- **Elide the HOST only; the scheme is never touched, and a non-default port is reattached after
  the label cut, never counted as part of it.** The scheme carries no authority information (it
  cannot be misread as a brand), so it always survives intact. The port belongs to the host and
  must survive too. Counting labels first and appending the port afterward means the port's
  length can never change which labels survive.
- **The same elided string is used for BOTH `title` and `detail` (`detail`'s LAST line; see the
  entry below), not a fuller string in one and a shorter one in the
  other.** `detail` wraps in a native message box; `title` does not, and per A127 may not render
  at all on some platforms. Showing the full, un-elided origin in `detail` and relying on
  wrapping was considered and rejected for exactly that asymmetry: it would leave `title`,
  wherever it *does* render, showing a different (and unprotected) string from `detail`. Using
  one function for both keeps them saying the same thing on every platform, whichever field
  survives.
- **The origin is duplicated into `detail`** (A127), a field Electron does not document as ever
  being dropped, because `title` may not render at all. A127 stays open on one term: no macOS machine has confirmed the platform claim
  that motivated it, so "the title is not reliably shown" remains reasoned, not measured.
- **Not done:** no attempt to mark the origin line as "not a name you typed" beyond the contrast
  already created by its own isolation as the last line (see the address-last entry below). A
  dedicated label (`Website: ...`) is presentation polish, not a security requirement.

**[`grant-prompt-render.ts`](grant-prompt-render.ts): the claimed name is the FIRST line of
`detail` and the origin is the LAST, in every dialog that shows one.** `manifest.name` is
app-chosen text a scam app can set to anything. With the origin first and the claimed name right
under it, a person reading quickly takes in the address, then the friendly name, and stops there.
The address is the one line in this box an app cannot fake; the name is the one line an app fully
controls, so the fakeable line never sits next to the decision.

`detail`'s lines are claim, then whatever content that dialog already carried (a capability's `explanation`, a
manifest's capability rows, an update notice), then the origin, for every one of the four
functions that build a `detail` string (`describeGrantRequest`, the shared `describeCapabilitySet`
behind `describeInstallConsent`/`describeCapabilityPrompt`, `describeReconsent`,
`describeRollbackChoice`). `title` is the origin, per AR-01's own reasoning that Electron may
not render `title` at all, so `detail` must carry it too.

**Where the claim goes was a real choice, not the only way to satisfy "address last"; and this half is
provisional.** Two shapes both put the origin last: claim-then-content-then-
origin (what shipped), or content-then-claim-then-origin, with the claim moved down to sit
immediately above the address instead of at the top. The second was rejected: it recreates the
exact adjacency this ordering exists to remove, just shifted one line down and still directly beside
the address at the moment that matters most: the two lines a hurried reader takes in together
right before clicking a button. Putting the claim at the top instead means every capability row
or notice sits *between* the fakeable name and the real address, so the address arrives alone,
with nothing app-chosen immediately next to it, exactly where AR-03's own rule (never let
`manifest.name` share a line with Orivon's words) already argues attention should stay clean.
Read as a whole, the new order also narrates better: state the (unverified) claim, say what it
wants or what changed, then ground it in the one verifiable fact right before the decision.

**Every dialog that shows an origin follows the same order (Rule 3).**
`describeCapabilityPrompt` and `describeInstallConsent` share `describeCapabilitySet`'s one
assembly point, so both follow it by construction. `describeReconsent` and
`describeRollbackChoice` build their own `detail` arrays directly (they render no capability
rows) and follow the same claim-first, address-last shape, each checked directly in
`grant-prompt-render.test.ts`.

**[`grant-prompt-render.ts`](grant-prompt-render.ts): `tcp.listen`/`udp.bind` carry the
"distinct, more serious prompt" `manifest.ts`'s own doc comment on `TcpCapability.listen`
promises, and `capability-api.md`'s open item 1 requires (A134).** Listening means the network
reaches the app: anything on the local network, and anything on the internet if the port is
forwarded, for an unsigned app a person merely visited, which is categorically different from the
app reaching out. So `tcp.listen`/`udp.bind` get `warning: true` unconditionally, plus an `explanation` naming the actual exposure, using the exact mechanism
`describeConnectCapability`'s wildcard-host branch already uses for the same purpose (Rule 3: one
vocabulary, not two). **Unconditional, not breadth-scaled:** unlike a connect grant, there is no
narrow case to distinguish: a listen pattern can never be `"*"` (rejected at manifest validation)
and every declared port range carries the same shape of risk, the same reasoning
`describeRollbackChoice` already uses for its own unconditional `warning: true`.
**Tcp and udp get their own, deliberately different, sentences** ("can connect to this app" vs
"can send this app data") rather than one shared string with the noun swapped, matching this
file's existing rule that two capabilities must never share a rendered sentence
(see the udp.send/tcp.connect distinctness test already in this suite).
**Rows that render the same headline are merged.** Unmerged, the flagship's real manifest
(`tcp.connect: ["*:*"]` + `tcp.listen` + `udp.bind` + `udp.send: ["*:*"]` + `fs`) renders 4 of 5
rows warned, with `"⚠ Unlimited network access"` appearing
TWICE (from `tcp.connect` and `udp.send`, each with its own explanation underneath). Read cold,
a repeated headline looks like a rendering bug, and a wall of four identical markers stops
telling the reader anything. A100's exit criterion is that unlimited looks unmistakably
different from narrow, not that everything serious looks the same as everything else serious.

**Two merges inside `describeCapabilitySet`, both removing REDUNDANT rows rather than
TRUE ones.** `mergeRowsWithIdenticalMessage` collapses any two rows that render the identical
headline into one, unioning their explanations, general on purpose, so it fires for whichever
capabilities happen to coincide, not only `tcp.connect`/`udp.send`. `describeInboundAccess`
merges `tcp.listen` and `udp.bind` into one row whenever a single request names both, because a
real P2P app declares both for the SAME reason (one port range, TCP peer connections and UDP
DHT/exchange), and rendering them as two separately-scary rows states one fact ("other computers
can reach this device") twice. Either capability alone still renders through
`describeCapabilityGrant`'s own unmerged case, including in the settings
permissions list (`../permissions.ts`), which needs each grant on its own revocable row and
never calls the merged path. With both merges the flagship shows exactly two warned rows: one per DISTINCT kind of breadth it actually declares (it can reach anywhere outbound,
and it can be reached from anywhere inbound), never a third or fourth restating one of those two.

**Considered and rejected: a second, lower-severity marker for `tcp.listen`/`udp.bind`, so
"unlimited" and "opens a door" would read as different tiers of the same scale.** Rejected
because they are not degrees of the same risk: an app choosing where it connects and a device
accepting connections from strangers are different KINDS of exposure, not one being milder than
the other, and grading one below the other would misstate that rather than declutter it. The
problem is redundancy (one fact stated on 2-4 rows), not that two genuinely different facts both
deserve a visible marker; removing the redundancy leaves exactly as many markers as there are
distinct facts, which is what A100 asks for in the first place.

**[`grant-prompt-render.ts`](grant-prompt-render.ts): "and N other sites" warns once the declared
host count reaches half of `MAX_PATTERNS` (A133).** The count is always honest, but past some
point the sentence stops being a fact a person can weigh: "and 4,271 other sites" is closer in
kind to an unlimited grant than to "a few named sites".

**Why the threshold is not a single-digit-vs-double-digit rule.** Warning past 10 other hosts,
where English shifts from naming small counts individually to a magnitude word ("dozens",
"many"), gets an ordinary app wrong. A 12-feed reader (`nytimes.com`, `bbc.com`, `reuters.com`,
...) is twelve individually meaningful, curated destinations, narrow by any sensible reading, and
it would trip the warning, because 11 crosses from one digit to two just as easily whether the
list behind it is curated or not. Single-digit-vs-double-digit measures how a number *reads*, not
whether a host list is broad.

**So the threshold is anchored on `MAX_PATTERNS`**, the enforced ceiling
(`loader/manifest-capabilities.ts`) on how many patterns one capability's array may ever declare,
already imported here for the wildcard-port check. The threshold is `MAX_PATTERNS / 2`, 128 at today's ceiling of 256. A feed reader's dozen sources clears it
by more than 10x; so would a large CDN allowlist of several dozen hosts. What trips it is a
manifest naming HALF of the total address space the format permits it to name at all, which is
the point past which a list has stopped being a materially narrower declaration than not naming
any hosts, close enough to the structural maximum that individual names have stopped doing
useful work for the reader. **This is presentation, not policy, and `MANY_HOSTS_THRESHOLD` can
be retuned freely**: nothing downstream depends on the specific fraction (half);
only on the threshold moving with `MAX_PATTERNS` rather than drifting from it, and on there being
*some* value that a plausible ordinary app cannot reach by accident.

**Past the threshold, the wildcard-host mechanism is reused rather than reinvented:** `warning: true`, a fixed headline
(`"⚠ Connect to a large number of sites"`, not the specific hosts), and an `explanation` that
keeps the true count and the first host rather than replacing them with a vaguer word.
**Considered and rejected:** naming more than one host before counting (does not address the
actual problem: spelled-out hostnames crowd a dialog exactly as much as a large integer fails
to inform one), a details expander (it would make a narrow declaration look like an unlimited one), and
counting distinct registrable domains instead of raw hosts (computing a registrable domain as a value to count, not
just a string to display, still needs a public suffix list this repo does not depend on --
`formatOriginForDisplay`'s label-count rule answers "how much of this host do I
show", never "what is this host's registrable domain", so it settles no part of this different
question, and it would not by itself have saved the feed-reader case anyway, since twelve
different news outlets are twelve different registrable domains; the fix that actually matters
here is the threshold's size, not the unit it counts in).

**[`grant-prompt-connect.ts`](grant-prompt-connect.ts) — a manifest pattern naming a loopback/
private/link-local address is never folded into "and N other sites" (A197).** A pattern like
`127.0.0.1:9000` or `169.254.169.254:80` is the ONLY thing that makes that address reachable at
all -- `hostMatches` (`../broker/policy/connect-patterns.ts`) never lets a plain hostname resolve
onto private space, even its own, so an address-literal pattern is a deliberate, specific grant,
never incidental. Before this fix `namedHostsSummary` treated it exactly like an ordinary public
hostname: folded into a count once it was not the first host in the list, and even alone it
rendered with `warning: false` and no indication of what kind of address it was -- `"Connect to
127.0.0.1"` read no differently from `"Connect to api.example.com"`. **A person can reasonably
skim a domain name; they cannot skim "your own device" the same way**, which is why this can
never be summarised the way an ordinary host count can.

- **Reuses the existing address classifier (`../broker/policy/address.ts`), not a second one
  (Rule 3).** `isPublicUnicast` is the gate (an address-literal pattern is "sensitive" exactly
  when that returns false); `classifyAddress`, the same file, supplies which class it is in
  (loopback, private, link-local, ...) for the wording. `hostSpecKind(host) === 'address-literal'`
  gates entry to this check at all -- a non-canonical literal (`0177.0.0.1`) already authorises
  nothing at connect time (`hostSpecKind`'s own doc), so it is left rendering as an ordinary named
  host, exactly as before; this fix is about addresses that actually grant something.
- **`warning: true` unconditionally, the same shape `tcp.listen`/`udp.bind` already use (A134).**
  Reaching a device on the person's own network is a categorically different kind of grant from
  reaching an ordinary public site, not a narrower version of the same one -- there is no "safe,
  narrow" private-address grant the way a single named public host is a narrow one.
- **Every sensitive address is named, with its class stated plainly, in a register matching
  `tcp.listen`/`udp.bind`'s own explanation ("your device", "your network") rather than a second
  vocabulary.** `"127.0.0.1 is your own device. This is not part of the public internet."` Ordinary
  PUBLIC hosts declared alongside a sensitive one still fold into a count exactly as before --
  only the addresses a person cannot afford to skim past lose that treatment.
- **A public IP literal (`93.184.216.34:443`) is untouched -- this only ever fires for address
  space `isPublicUnicast` already says no to (T12's own boundary), never for an ordinary public
  address that happens to be written as a literal instead of a name.**

**A198, investigated and NOT reproduced: a blank-line-padded pattern cannot reach a rendered
dialog.** The claim was that a pattern supplied through `app.requestGrant` could carry blank
lines, padding the rendered list so real content scrolls out of view. Checked directly, not
assumed: `describeCapabilityGrant` was called with deliberately padded patterns (leading/
trailing/internal blank lines, and a pattern that is nothing but blank lines) -- the MOST
permissive path available, since this function has no validation of its own and every production
caller validates first. `parsePattern` (`../broker/policy/connect-patterns.ts`) trims the whole
pattern before splitting host:port, so leading/trailing padding is silently stripped and never
rendered; a pattern carrying an INTERNAL blank line fails `isAsciiHost` (which rejects any control
character, including `\n`/`\r`, anywhere in the trimmed text) and the whole pattern is dropped
from the summary, never rendered padded. Separately, and before rendering is ever reached: both
`isDeclarableConnectPattern` (the `app.requestGrant` gate, `../broker/policy/request-grant.ts`)
and `validateConnectPattern` (the manifest-parse gate, `../loader/manifest-capabilities.ts`)
already reject any pattern where `pattern !== pattern.trim()` outright -- a check that file's own
comment says exists specifically "to catch the padding parseConnectPattern's own trim would
otherwise hide from us." No render-side change was made; the test suite records the investigation
(`tests/grant-prompt-connect.test.ts`) so it does not need re-deriving.

**[`grant-prompt-render.ts`](grant-prompt-render.ts) — a multi-label PRIVATE hosting suffix no
longer swallows the tenant label (A161, AI recommendation).** A142/the three-label rule (above)
is correct for a ccTLD registry suffix (`example.co.uk`), but some cloud/PaaS platforms register
a PRIVATE suffix -- not a registry one -- that is itself three or more labels long:
`s3.amazonaws.com`, `storage.googleapis.com`, and AWS's regional compute suffixes
(`<region>.compute.amazonaws.com`), all confirmed against the live Public Suffix List, not
assumed. The fixed three-label cut can land entirely inside one of these, dropping the
tenant/bucket label -- the one an attacker actually controls -- and leaving a string
(`...s3.amazonaws.com`) that reads as the platform's own domain rather than a truncated one.

- **The fix is a small, evidenced allow-list (`RECOGNISED_PRIVATE_SUFFIXES`), not a public-suffix-
  list dependency.** A142 already established why a naive guess is wrong and a real PSL is a
  dependency this repo does not carry (parked); this list is neither -- it names only the specific
  suffixes this codebase has concrete evidence for, matched label-for-label (never a substring, so
  `nots3.amazonaws.com` does not match), and costs nothing to extend or wrong nothing it does not
  recognise -- an unrecognised host keeps the plain three-label cut, unchanged.
- **A host ending in a recognised suffix widens the kept window to that suffix plus ONE more
  label**, rather than showing the suffix alone: `attacker.storage.googleapis.com` (4 labels) now
  shows in full; the owner's own worked example, an A115-style confusable relocated behind a real
  S3 suffix (`accounts.google.com.attacker.s3.amazonaws.com`), now elides to
  `...attacker.s3.amazonaws.com` -- the attacker-controlled label survives even though the
  confusable prefix ahead of it still does not, which the `...` marker (unchanged, always present
  on any truncation) continues to flag honestly as incomplete.
- **Alternatives considered, both viable, neither chosen:** refusing to elide at all whenever
  elision would remove the host's single most specific label (simpler, no suffix knowledge
  needed, but would also widen the window for hosts with no actual platform-suffix risk, which is
  a real behaviour change to the A142-resolved rule for no evidenced gain), and leaving the rule
  exactly as shipped, treating this as fully subsumed by A142's eventual PSL dependency (does
  nothing today for the concrete cases this entry has evidence for). The allow-list was chosen as
  the smallest change that actually fixes the evidenced cases without touching the rule's
  behaviour for anything else.
- **Still open, by design:** this is a narrow, evidenced list, not comprehensive -- a regional S3
  endpoint (`bucket.s3.us-east-1.amazonaws.com`, a different suffix shape entirely) and any
  platform not on the list still get the plain three-label cut, unchanged from before this fix.
  Closing the general case needs the same public-suffix-list dependency A142 parked; this entry
  does not attempt to substitute for it.

**[`install-consent.ts`](install-consent.ts): "once per origin, ever" (A139) is derived from the
grant ledger's own hydration, not tracked as a second piece of state.** `requestInstallConsent`
could have kept its own persisted "was this origin ever asked" flag. It does not, because
`GrantLedger.registerApp`'s existing `grantsHydrated` mechanism already restores every still-valid
persisted grant into the live ledger, checked against the manifest `app-install.ts` just fetched,
before this function ever runs, so an origin accepted on any earlier visit, this session or a
past one, already holds a live grant for its declared capabilities by the time this checks
`broker.app.grants(origin)`. A second flag recording the same fact would be exactly the Rule-3
duplicate this codebase keeps naming and then finding later.

**A fully DECLINED visit is a real persisted record, not an inference (`A145`).** All-or-nothing
(`A138`) means declining creates no grant at all, so `grantsHydrated` has nothing to derive an
answer from. `requestInstallConsent` checks `broker.declinedCapabilitiesFor(origin)` between the
"already held" check above and showing the dialog: a manifest whose declared set is fully covered
by what was declined stays suppressed, and a manifest asking for something NOT in that set (a
widen) is asked again. `GrantLedger.recordDeclinedConsent`/`clearDeclinedConsent`
(`src/broker/grants/declined-consent.ts`) are the write side: the accept branch clears the
record, so an old "no" cannot outlive a later "yes". This is ADVISORY ONLY: it can suppress this
dialog, never grant anything, and `app.requestGrant` (`./request-grant.ts`) remains a completely
independent, unaffected path for an app that offers its own in-app "connect" affordance. Whether a
LATER-NARROWED manifest should still be asked again is provisional and explicitly retunable;
see `A145` for the argument either way.

**[`app-install.ts`](app-install.ts): what "before the app's own scripts run" actually means
here, stated precisely because the two readings differ.** `requestInstallConsent` is awaited
inside `installFromHint`'s own `'installed'` branch, so the dialog is fully resolved (shown,
answered, every accepted capability granted) before `installFromHint`'s promise ever resolves.
That is the strongest guarantee available here: nothing downstream of this function's return can
observe an unconsented app. **It is NOT "before this page's scripts execute", and the difference
matters more than it first looks**; see `open-questions.md` A146.

The production caller is [`manifest-hint.ts`](manifest-hint.ts), the discovery trigger.
It fires when the page's own delivered HTML is parsed, which means **the page is already running
by the time consent is asked.** An app's first-visit script can therefore call a capability while
the dialog is still on screen, and get `'denied'`, which is precisely the race asking before the
app's code runs is meant to remove. On every later visit there is no race at all: the grant is
already held, so the app starts with a decided answer. The gap is first visit only.

Closing it would mean holding the page before its scripts run, a change to how a tab navigates
rather than anything this file can do. It is accepted as a known limitation (A146).

**[`app-install-subsystem.ts`](app-install-subsystem.ts): publishes `ctx.installApp`, the one
install entry point.** It closes over the broker, the loader and the real consent dialog
together, and [`manifest-hint.ts`](manifest-hint.ts) consumes it rather than building its own
`AppInstallDeps`. One definition of how `installFromHint` is wired for real means two call sites
cannot drift, with one passing `consent` and the other forgetting it, which would silently degrade
to "every app installs with nothing granted" with no error anywhere.

**[`request-grant.ts`](request-grant.ts): re-reads the manifest, and re-runs
`decideGrantRequest`, between `consent()` returning and `broker.grant()` committing (`A153`,
`docs/open-questions.md`).** `consent()` can await a real dialog for up to 120 seconds (`A140`),
and `installFromHint` (`./app-install.ts`) can re-register a narrower manifest for the same
origin at any point during that wait, and a page can trigger this by reloading itself, which
re-runs its `<link rel="orivon-manifest">` hint (`src/preload/manifest-hint.ts`). Without the
re-check, `broker.grant()` would commit a decision computed against a manifest that may no longer
be the one in force, and `GrantLedger.grant()` has no invariant of its own to catch that:
capability-api.md's design rule 4 ("a grant can never exceed the manifest") would hold only at the
moment `decideGrantRequest` first ran, not at the moment the grant lands. The re-check
uses the EXACT patterns already shown to the person (`decision.patterns`), never a fresh request,
so accepting means exactly what was asked and nothing wider ever slips through on a re-read that
happens to be more permissive. **Deliberately not also serialised through `withOriginQueue`**:
the re-check alone closes the security hole outright, and a queue would only change TIMING --
making one origin's grant dialog wait behind another's install (which can itself show a dialog,
another up to 120 seconds) rather than closing anything the re-check leaves open. Provisional;
see `A153`.

**[`grant-changed-capabilities.ts`](grant-changed-capabilities.ts): extracted so
`./install-consent.ts` and `./update-outcomes.ts` cannot each get "was this capability's
authority actually different" wrong in a different way (`A156`, `A157`).** `broker.grant()`
(`src/broker/index.ts`) always mints a fresh `GrantId` and tears down every live handle under the
grant it replaces, which is correct and deliberately tested for a REAL authority change (`A84`).
Calling it for every capability in a "capabilities to grant" list, including ones already held
with an identical pattern set, would do real harm: accepting an update that only adds `fs` would
silently kill an open, unrelated `tcp.connect` socket, because the update's capability list still
names `tcp.connect` even though nothing about it changed. So both call sites grant only what
actually changed. Comparing pattern sets ORDER-INDEPENDENTLY matters here specifically --
a manifest re-declaring the same patterns in a different order must read as unchanged, not as a
widening that happens to net out to the same set.

**[`install-consent.ts`](install-consent.ts): bound 2 is `.every`, not `.some` (`A157`).**
`app.requestGrant` (`./request-grant.ts`) is a second door to a grant, reachable while a page's
own scripts are already running (`A146`), and `registerApp` runs before this function in
`app-install.ts`'s own `finishInstall`, so an app could call `requestGrant` for exactly one of
its declared capabilities before this check ever sees it. `.some` would read "any declared
capability already held" as "already asked", which is true when this function granted
everything, but also true after that one out-of-band grant, and skipping the WHOLE dialog then
would permanently withhold every other declared capability, silently. `.every` only skips once
nothing declared is left unheld. This is an INFERENCE from held grants, not a record of "asked,
and here is the answer". The decline case has a real persisted record (`declined-consent.ts`);
the accept case deliberately does not, because a live `Grant` is already stronger evidence of
"asked and agreed" than a separate marker recording the question would be. Whether this residual
inference is an acceptable floor or needs its own persisted marker is still open (`A157`).

**[`install-consent.ts`](install-consent.ts) / [`grant-prompt-choice.ts`](grant-prompt-choice.ts) /
[`install-consent-prompt.ts`](install-consent-prompt.ts): A138's `'per-capability'` path: what
"outstanding" replaces, why the real dialog is a staged native sequence rather than a custom
window, and what a partial decline means for the remembered-no record.**

*Why `requestInstallConsent` uses one `outstanding` filter rather than two whole-set checks.*
Two checks ("skip if EVERY declared capability is held", "skip if EVERY declared capability is
declined") are sound only while every decision covers the WHOLE declared set at once, as an
all-or-nothing decision does, so `held` and `declined` can never both be non-empty,
non-overlapping subsets of the same request. A `'per-capability'` decision makes that mixed state
reachable (e.g. `held = [tcp.connect]`, `declined = [fs]`), where neither whole-set check fires and
the dialog would ask again every restart about a capability already decided in both directions.
`outstanding` (capabilities covered by NEITHER `held` NOR `declined`) generalises both checks and
collapses to them whenever the mixed state cannot occur (`install-consent-per-capability.test.ts`'s
restart suite, and every `install-consent.test.ts` case).

*Why the all-or-nothing dialog still shows the WHOLE declared set, not `outstanding`, while the
per-capability one asks only about `outstanding`.* `A157`'s test pins this asymmetry: a person choosing all-or-nothing must see the complete picture even when part of it is
already held from an out-of-band `app.requestGrant` call, because `grantChangedCapabilities`
already skips re-granting anything unchanged, and showing the narrower `outstanding` set there would
under-inform the person about what the app actually holds. Per-capability has no such reason to
over-ask: each capability gets its own explicit yes/no, so one already decided (held or declined)
has nothing left to ask.

*Why the real per-capability surface is a staged sequence of native dialogs, not a window Orivon
renders itself.* Three shapes were considered: a plain
sequence of independent native dialogs, a self-rendered checkbox-list window, or something staged.
A plain sequence was rejected for reproducing exactly the fatigue the combined dialog (`A139`) was
built to remove, and for never showing the whole request before any one part is decided. A
self-rendered window is the only shape with a true checkbox list, but it is a new privileged
surface: its own `webPreferences`, its own CSP, load-bearing the same way the chrome view's is
(this file's own §Design notes on that view), for a feature that is still an open design question
rather than a settled requirement. The staged shape keeps the common cases to one dialog
(`Allow all` / `Deny all`) and
keeps the WHOLE request visible on every screen of the individual-choice path
(`describeCapabilityChoice`, one screen per capability, marking the current row and everything
this same sequence already decided), the one property a plain sequence cannot offer at all, at
zero new-surface cost. **Provisional:** a self-rendered window remains the better long-term answer
if a true checkbox list is wanted once this surface proves out.

*What a partial acceptance does to the remembered-decline record.* The record is one list per
origin (`A145`). Replacing it wholesale on each decision would erase an unrelated earlier
decline: if a person declined `fs` last week and today accepts `tcp.connect` (a different,
newly-declared capability), replacing the record with just this round's answer would un-decline
`fs` nobody revisited. So the new record is the old one plus exactly this round's fresh refusals,
never a subtraction; because `outstanding` already excludes anything in the old `declined` set,
nothing this round accepts or refuses was ever a member of it. An accept is never separately recorded;
`grantsHydrated`'s own derivation (`A139`, above) already covers it once the grant lands.

**[`web-context-host.ts`](web-context-host.ts)'s two WebRTC belts, and why a proxy pointed at the
discard port does not also break the context's own `fetch()`.** ADR-0019 promises an isolated
context "no network of its own"; `protocol.handle('https'/'http', ...)` and
`webRequest.onBeforeRequest` (cancelling `ws:`/`wss:`) cover everything that passes through
Electron's own protocol/request layer, but WebRTC's ICE/STUN/TURN dial does not -- it is Chromium's
network service talking raw UDP/TCP, a gap `docs/open-questions.md` A41 already names as
unsolved and platform-wide for app tabs generally. A context has no legitimate reason to use
WebRTC at all, so rather than trying to scope a partial allowance the way A41's own open item
frames the harder app-tab problem, it is closed outright, with two independent belts so that a
single missed path does not silently reopen it:

- `webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` forces WebRTC to route
  through a proxy or not run at all.
- `session.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' })` on the
  partition, pointed at the loopback discard port (RFC 863) -- nothing answers there, so whatever
  that policy hands to a proxy dies on arrival, and so does anything else this session's own
  network stack might dial outside the two handlers above.

**Why the proxy does not intercept the context's own `fetch()` to a granted origin.** Proven
against the real shell, not assumed: `test/e2e-web-context-network.test.ts` fetches
`https://example.com` through a context with both belts active and still gets a real response.
This holds because `protocol.handle` REPLACES Chromium's network stack for the scheme it
registers -- a request answered by a custom protocol handler never reaches the proxy-resolution
step at all, the same reason `serve.ts`'s own app-origin handler never needed proxy awareness.
The proxy only ever sees a connection attempt that `protocol.handle` did NOT intercept, which for
`https:`/`http:` from inside a context should never happen -- so the discard-port proxy is a
belt for exactly the gap outside those two schemes, not a second gate in front of them.

Verified against Electron 44's own `electron.d.ts`, not assumed: both APIs are documented there
with these exact shapes (`WebContents.setWebRTCIPHandlingPolicy`, `Session.setProxy` taking a
`ProxyConfig` with `mode`/`proxyRules`).
