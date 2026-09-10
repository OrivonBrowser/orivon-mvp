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

**[`favicon.ts`](favicon.ts) — main fetches favicons to a `data:` URL rather than letting the
renderer fetch directly.** AI recommendation, not yet an owner decision. The chrome view's CSP
(`index.html`) is a one-line, readable guarantee today that the one privileged view in this app
makes zero outbound requests. Letting the renderer `<img src>` an arbitrary, attacker-influenced
`https://` URL directly would need `img-src 'self' https:` and hands a hostile page a live
request from the privileged, cookie-bearing chrome origin — a new, silent tracking surface
exactly where this codebase has been careful before (`mvp-scope.md` already flags DuckDuckGo
search itself as a stated "known limitation" for far less: leaving the machine at all). Fetching
in main instead keeps the guarantee intact; the CSP only needs `img-src 'self' data:`.

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
