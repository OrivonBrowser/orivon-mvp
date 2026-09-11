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
