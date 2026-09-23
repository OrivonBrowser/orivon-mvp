# `src/main/shell/`: the window, and the views inside it

**What lives here.** `window.ts` composes the frameless `BaseWindow`: a chrome view on top,
whichever tab's `WebContentsView` below. `tabs.ts` owns the tab collection and what gets pushed
to the chrome UI; `tab-view.ts` and `tab-types.ts` are its pure halves. `renderer-entry.ts`
resolves electron-vite's dev-server/file-URL split for both this and
[`../permissions/permissions-panel.ts`](../permissions/permissions-panel.ts). `user-agent.ts`
derives the plain Chrome User-Agent [`../index.ts`](../index.ts) sets app-wide.

What a page asks of its window: `popups.ts` turns `window.open()` and `target=_blank` into
tabs; `fullscreen.ts` decides which tab, if any, fills the window; `window-notice.ts` is the
window's one few-second notice ("Press Esc to exit full screen", "Press Esc to show your
cursor", "Press and hold Esc to exit full screen"), and `exclusive-access-notice.ts` picks the
pointer- and keyboard-lock messages; `leave-page-prompt.ts` asks the question a `beforeunload`
guard raises; `external-link-prompt.ts` and `notification-prompt.ts` ask the two questions the
permission gate puts to the person; `showing-window.ts` finds the window a tab is on screen in;
`context-menu.ts` is the right-click menu for tabs and the chrome.

**What it depends on.** `electron`; [`../../broker/`](../../broker/) (`policy/origin.ts`,
`grants/origin-hash.ts`, `broker-contracts.ts` types); [`../../loader/electron-serve.ts`](../../loader/electron-serve.ts)
(type only); and, inside `src/main/`, [`../browsing/`](../browsing/) (bookmarks, favicon,
omnibox, delivery-provenance), [`../ipc/`](../ipc/), [`../permissions/`](../permissions/),
[`../consent/grant-prompt-origin.ts`](../consent/grant-prompt-origin.ts) (the origin line every
permission dialog shows), [`../sessions/`](../sessions/) (the two questions' types),
[`../dev/dev-mode.ts`](../dev/dev-mode.ts) (the developer-mode flag, for Inspect Element), plus
the top-level `channels.ts` and `registry.ts`.

**What it must never import.** [`../../renderer/`](../../renderer/) code (the repo-wide rule).
Locally: [`tab-view.ts`](tab-view.ts) and [`tab-types.ts`](tab-types.ts) must never import
[`tabs.ts`](tabs.ts) — they were split OUT of it precisely so the pure parts have no
`TabManager` state to depend on, and an import the other way would recreate the coupling the
split exists to remove.

**Owner stream.** `shell`, build step 1, **done**. Maintenance only.

## Design notes

**[`tab-view.ts`](tab-view.ts)'s `reportAppFailures` prints an app tab's own failures to the
shell's stdout, and only an app tab's.** An app whose bundle throws while its module graph is
still evaluating renders nothing and the throw never leaves the renderer, so the symptom is a
blank window and an empty terminal -- which is what made this case expensive to find. The
report is bound to the `--orivon-app-tab` flag because the open web logs errors constantly, and
narrating all of them would bury the one case being debugged;
[`../../../test/e2e-app-failure-report.test.ts`](../../../test/e2e-app-failure-report.test.ts)
asserts the silence as well as the noise. It hangs off the view rather than
`app.on('session-created')` the way [`../sessions/permission-gate.ts`](../sessions/permission-gate.ts)
does, and that is not an inconsistency: a session precedes and outlives the views on it, while
these three events are webContents-scoped and fire on one view's own contents.

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
`tests/tabs.test.ts` exercises this directly with a fake `webContents` that emits `'destroyed'`
synchronously from `close()`, the same way real Electron destruction can.

**[`tabs.ts`](tabs.ts): what `TabManager`'s `ctx: SubsystemContext` is for, and why one half
of it is unused.** `ctx.broker` is read by every `makeTabView` call site (`appTabArgsFor`,
ADR-0017) to decide the `fetch()`-routing flag. It stays `Broker | undefined`, so a run where
the broker subsystem is absent simply never sets the flag, the same fallback shape
`partitionForTarget` already has. `ctx.loader` is threaded through but `TabManager` reads it
nowhere: the discovery trigger ([`../install/manifest-hint.ts`](../install/manifest-hint.ts))
installs through the published `ctx.installApp` instead. Anything that does read `ctx.loader`
must treat it as possibly absent: `loaderSubsystem` is not `critical`, unlike the broker.

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

**[`popups.ts`](popups.ts): a popup keeps its opener's session, except into an isolated
app.** A popup that keeps `window.opener` is Chromium's own new webContents, created in its
opener's storage partition, and no other session can hold it; the tab adopts it there. For the
same reason `wireView`'s did-navigate does not move a tab that still has its opener onto the
default session: that swap severs `window.opener`, and a sign-in popup's whole job ends with the
provider redirecting back to the app's callback page and posting to the opener. The cost is an
ADR-0018 residual: until its opener closes, an open-web page an app opens as a popup runs in the
app's partition, so a sign-in provider's cookies land there. The other direction is never
allowed, opener or not. A tab reaching an isolated app always moves into the app's own session,
and `routePopup` opens a popup into one from any other session as an ordinary tab, because that
session is the only place the app's pinned bundle is served (ADR-0007); anywhere else the app's
origin would run whatever the network sends, with its grants. Links, plain `window.open(url)`
calls that would cross sessions, and `noopener`/`noreferrer` also get an ordinary new tab, which
loads in the right session from its first request. A popup's `--orivon-app-tab` flag follows its
own URL, not its opener's, so a third-party page an app opens never gets Node globals or routed
`fetch()`. **Trap:** the adopting `WebContentsView` must be given the popup's `webPreferences` as
well as its webContents; with the webContents alone, Electron 44 drops the preload and the popup
has no `orivon` surface at all.

**[`fullscreen.ts`](fullscreen.ts): Electron fullscreens the window, not the view.** On
`requestFullscreen()` Electron puts the owning window into fullscreen and takes it out again, but
a `WebContentsView` keeps the bounds it was given, so the page stayed under the chrome.
`window.ts` hides the chrome and gives the tab the whole content area while
`HtmlFullscreen.tabId` is set. Escape needs no handler here: Electron's exclusive-access manager
consumes it in the browser process before the page sees the key, which is what makes allowing
the permission safe (`../sessions/README.md`). When the shell itself ends fullscreen (another
tab became active), it asks the page through an isolated world, where the page's own script
cannot have replaced `document.exitFullscreen`.

**[`window-notice.ts`](window-notice.ts): a notice is loaded before it is attached, one view per
message.** Measured in the real shell: a `WebContentsView` that navigates while attached to the
window takes focus from the page under it. A notice loaded that way ended a pointer lock one
millisecond after it began, and on entering fullscreen it took the page's keyboard focus, so a
video player's Space and arrow keys went to the notice. Each message's view is loaded while
detached and added on `did-finish-load`; changing the message swaps views instead of navigating
the one on screen. [`../../test/e2e-shell-fidelity.test.ts`](../../test/e2e-shell-fidelity.test.ts)
asserts the page keeps its focus in fullscreen.

**[`leave-page-prompt.ts`](leave-page-prompt.ts) blocks the main process while it is open.**
Electron settles `will-prevent-unload` from the handler's return, with no way to answer later,
so the question is a synchronous message box; every tab's broker traffic waits until it is
answered. Chromium only asks after the person has interacted with the page. Closing a tab does
not ask: `closeTab()` closes the webContents without running `beforeunload`.

**[`user-agent.ts`](user-agent.ts): the string, not the brand list.** `navigator.userAgentData`
still lists Chromium rather than Google Chrome, and Electron has no API to change it. A site that
checks that list for Google Chrome sees what it sees in any other Chromium-based browser.

