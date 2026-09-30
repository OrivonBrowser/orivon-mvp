# `src/main/shell/`: the window, and the views inside it

**What lives here.** `window.ts` composes the frameless `BaseWindow`: a chrome view on top, the
active tab's `WebContentsView` below, or the two panes of a split. A process holds any number of these
windows: `shell-services.ts` is what they share, and `window-registry.ts` is how a page's IPC finds the
window holding it. `window-frame.ts` is the native window itself and `window-options.ts` says how a new one
opens. `window.ts` is the composition; its parts are `window-layout.ts` (where the chrome and the page
area sit: the one place a page area is computed), `window-state.ts` (the `ShellState` push, and which
overlays a tab switch or a navigation dismisses), `window-panels.ts` (the permissions and site-info
popovers) and `shell-state-parts.ts` (the `ShellState` fields a feature adds). `window-context.ts` is
the `{ window, services }` pair a hook or an overlay handler receives.
`tabs.ts` owns the tab collection, with `tab-state.ts` (the state a tab reports, plus what each
`TAB_SIGNALS` entry adds), `tab-navigation.ts`, `tab-open.ts` (every way a tab is created) and
`tab-panes.ts` (which views show where) as its parts; `tab-view.ts`, `tab-partition.ts`,
`app-tab-watch.ts`, `tab-signals.ts`, `tab-types.ts`, `tab-factory.ts`, `tab-lifecycle.ts` and
`tab-parking.ts` are the per-tab view. `tab-origin-liveness.ts` is `tab-view.ts`'s own per-origin
live-document counter. `tab-order.ts` is where a tab sits in the strip, `tab-move.ts` moves one between windows keeping the
same page (and is where a dragged tab's cross-window target -- which window's strip, and where in it -- is
worked out, shared by the actual move and by `tear-drag.ts`'s own mark), `tab-menu.ts` is its right-click
menu, and `window-actions.ts` is what the chrome's buttons and menus ask of their window, and `chrome-actions.ts`
(with `actions/`) is where a chrome module's own call to main lands. `drag-mode.ts`
decides whether the empty tail of the strip is native OS drag content or JS-driven (Linux/X11 only);
`window-move.ts` is the arithmetic a manual window move and its Aero-snap-style edge release use.
`tear-drag.ts` is the floating preview a tab shows once torn out of its strip, and the mark it leaves on
whichever window's strip it is dragged over. Split view: `split-model.ts` is the arithmetic and the groups
of joined tabs, `split-controller.ts` plans which views show where, `pane-host.ts` puts them on screen in
that order, `split-frame.ts` is the view behind two panes, and `split-drop.ts` says where a dragged tab
would split the page. `intro-state.ts` and `intro-view.ts` are the welcome screen.
The rest answer what a page asks of its window: popups become tabs, HTML fullscreen, the
few-second exclusive-access notices, the `beforeunload` Leave/Stay question, the external-link
and notification questions the permission gate asks, the right-click menu for tabs and the
chrome, and the plain Chrome User-Agent every page sees. `lock-navigation.ts` refuses every navigation
and popup on a view that must stay on the document it was created for: the chrome view and its
popups, whose privileged preload would follow any navigation, and
[`../sessions/web-context-host.ts`](../sessions/web-context-host.ts)'s isolated context, which
has no preload but is confined to one origin (ADR-0019). `shell-session.ts` names the one
Electron session every view that shows Orivon's own UI runs in, never a tab's.

**Views on the shell's own session, never a tab's.** The chrome view (`window.ts`), the intro
screen (`intro-view.ts`), the fullscreen/pointer-lock notice (`window-notice.ts`), the split
view's frame (`split-frame.ts`) every popover built by
[`../permissions/popover-view.ts`](../permissions/popover-view.ts) (permissions, site info) and
every overlay view ([`../overlays/`](../overlays/)) set `webPreferences.partition` to `shell-session.ts`'s `SHELL_PARTITION`. Internal pages
have their own session (ADR-0041). An ordinary tab, and the
new-tab dashboard (a tab that happens to navigate to `file://`), stay on
`session.defaultSession`; the Design notes below say why.

The main menu under the toolbar's menu button: `menu-layout.ts` lists which commands it shows and in
what shape (the names and keys come from [`../shortcuts/`](../shortcuts/), so the menu cannot show a
key that does not work), and `menu-overlay.ts` is its `OverlayDef`, shown by the overlay host in
[`../overlays/`](../overlays/). A feature adds its entry to `MENU_LAYOUT` beside the entries it belongs
with; an entry is a command, a tick (`check`), a command with a note (`item`), the zoom row, or a
`submenu`. `theme-colors.ts` is the pre-paint background colour every view here that is attached
ahead of its own first paint needs (a fact more than one of them shares); `view-background-
test-hook.ts` is the e2e-only record of what each was actually set to.

**What it depends on.** `electron`; [`../../broker/`](../../broker/) (`policy/origin.ts`,
`grants/origin-hash.ts`, `broker-contracts.ts` types);
[`../../loader/electron/serve.ts`](../../loader/electron/serve.ts);
[`../../protocols/builtin.ts`](../../protocols/builtin.ts); and, inside `src/main/`,
[`../browsing/`](../browsing/), [`../ipc/`](../ipc/), [`../permissions/`](../permissions/),
[`../shortcuts/`](../shortcuts/) (the command table and the service the menu reads, and the command bus a window runs a chosen command through),
[`../consent/grant-prompt-origin.ts`](../consent/grant-prompt-origin.ts) (the origin line every
permission dialog shows), [`../sessions/`](../sessions/) (the two questions' types, and
`permission-gate.ts`'s notification store, handed to the permissions panel),
[`../dev/`](../dev/) (the developer-mode flag, the score-level override, the local resolvers),
[`../verifier/`](../verifier/), the stores and services a window reads ([`../settings/`](../settings/),
[`../history/`](../history/), [`../zoom/`](../zoom/), [`../devtools/`](../devtools/),
[`../pages/`](../pages/), [`../launch/`](../launch/)), plus the top-level `channels.ts` and `registry.ts`.

**What it must never import.** [`../../renderer/`](../../renderer/) code (the repo-wide rule).
Locally: [`tab-view.ts`](tab-view.ts), [`tab-types.ts`](tab-types.ts) and
[`tab-parking.ts`](tab-parking.ts), [`tab-partition.ts`](tab-partition.ts) and
[`tab-signals.ts`](tab-signals.ts) must never import [`tabs.ts`](tabs.ts): they are the per-tab view,
with no `TabManager` state to depend on.

**Durable or tied to Electron.** Tied to Electron throughout: every file here exists to drive
`BaseWindow`, `WebContentsView` or `dialog`.

**Owner stream.** `shell`, build step 1, **done**. Maintenance only.

## Design notes

**`tab-view.ts`, `tab-partition.ts` and `tab-parking.ts` import each other.** Nothing in them runs
at module load across that cycle, so the order Node loads them in does not matter; keep it so, and
never use one of their exports at the top level of another.

**A tab's own state is a record and a list of signals, not a method on `TabManager`.** A feature that
needs per-tab state adds a field to `TabRecord` and `TabState`, and a `TabSignal` in
`tab-signals.ts` for what to watch on the `WebContents`; `tabClosing` in `tab-lifecycle.ts` tells it
when the tab ends and why. `TabViewHost.services` and `runCommand` give code that runs on a view
(the context menu) the shared stores and the command bus.

**[`shell-session.ts`](shell-session.ts): the shell's own views never share a session with a
tab.** Chrome extensions load into `session.defaultSession`, the session every ordinary tab and
the dashboard use, and may act on `<all_urls>` there, so a privileged view on that session would
be reachable the same way. The dashboard stays out of their reach in a packaged build because it
is `file://` and no extension is given file access. `SHELL_PARTITION` is `persist:` so a
privileged page may one day use `localStorage` without losing it; none does now.
`permission-gate.ts` and `verifier-subsystem.ts` cover the partition through
`app.on('session-created', ...)`, registered in `beforeReady` (`../subsystems.ts`), before
`createShellWindow` first creates it.

**[`tabs.ts`](tabs.ts): a tab changes session by replacing its view.** Electron fixes a
partition at construction, so every path that can change a tab's origin swaps its
`WebContentsView` (`repartitionView()`), keeping the tab's id, position and active state:
`navigate()` for a typed URL, and `wireView()`'s `did-navigate` for a redirect, link, form or
script navigation (A108). `tab-view.ts`'s `partitionChanged` is the one comparison both use.
**Trap:** every handler `wireView()` attaches acts only while its view is `record.view`, so the
old view is retired only after `record.view` has moved on; retire it first and its
`'destroyed'` calls `forgetTab()` on a tab that is not closing (`tests/tabs.test.ts`). **Trap:**
the dashboard's dev-mode URL is a real `http(s)` address, so its own first `did-navigate` would
read as an origin change; the handler excludes the dashboard explicitly.

**Residual: `did-navigate` fires after commit**, so the new origin's page has rendered once in
the old partition and may already have read from it. Intercepting before commit would cost a
fresh view and a lost history entry on every cross-origin link; it is open as A109.

**One process, several windows: what is per window and what is shared.** Per window: the chrome view, the
`TabManager`, the popovers, the fullscreen and notice state, and the IPC handlers on the chrome view and the
popovers, which are registered on those views' own `ipc` so two windows never collide on a channel. Shared:
the `BookmarkStore` (built once and read once: a second read would replace the list with the file and drop a
change not yet flushed; its listeners return a removal each window runs when it closes), the `WindowRegistry`,
and the new-tab page's `ipcMain` channel, registered once. A closing window closes every view it made.
Destroying a window destroys only what is attached to it, so `TabManager.dispose()` closes the tabs' views
first: a background tab's view and every parked view are detached, and their renderers would outlive it.

**A tab's handlers read `record.host` when an event arrives**, never a host captured at wiring, so a tab that
moves to another window keeps them (`tests/tab-events.test.ts`). Every handler `wireView()` attaches acts only
while its view is the one the tab shows, and `repartitionView()` retires the old view only after `record.view`
has moved on: retire it first and its `'destroyed'` calls `forgetTab()` on a tab that is not closing.

**A joined pair stays whole.** A tab moved into the strip goes past a pair, not between its tabs
(`tab-order.ts`, also for a tab given by another window); a pair moves as one from the keyboard; and when
the tab beside a closed or departed one was in a split, `forgetTab()` lays the views out again so the
survivor has the whole area. A page holds the window in HTML fullscreen only while its tab is the one in
front, and a tab that closes or is left has no claim on it. `forgetTab()` takes the record out before it
closes the view, because closing announces its own end at once and that call must find nothing to do.

**[`tab-parking.ts`](tab-parking.ts): a view leaving an app's partition is parked, not closed.** A
page's `sessionStorage` lives in its view, not its partition (measured in Electron 44), so a
fresh view would break an OIDC login that keeps its state there while the provider has the tab.
Only app partitions are parked; the open-web side of a swap still loses its history.

**[`tab-origin-liveness.ts`](tab-origin-liveness.ts): how many live tabs sit at each origin is
tracked module-wide, not per `TabManager`.** Two windows' tabs on the same origin share one broker
origin table (`../../broker/broker-contracts.ts`'s `dropOrigin`), so a per-window count would let
one window's tab close tear down handles a tab in another window still holds. `tab-view.ts`'s
`wireView()` calls into it from the `did-navigate` and `'destroyed'` handlers, where a document's
count moves; both run unconditionally, ahead of the handlers' own `shown()` gate, because a
parked or background view's navigation changes this count
exactly as a visible one's does.

**[`tabs.ts`](tabs.ts): `TabManager`'s `ctx`.** `ctx.broker` decides the `fetch()`-routing flag
at every `makeTabView` call (`ADR-0017`) and may be `undefined`, in which case the flag is never
set. `ctx.loader` is threaded through and read nowhere: the discovery trigger
([`../install/manifest-hint.ts`](../install/manifest-hint.ts)) installs through `ctx.installApp`.
Anything that does read `ctx.loader` must treat it as possibly absent, since `loaderSubsystem` is
not `critical`.

**[`popups.ts`](popups.ts): a popup keeps its opener's session, except into an isolated app.**
A popup that keeps `window.opener` is Chromium's own webContents, created in its opener's
partition, and moving it would sever `opener`, which a sign-in popup needs to report back. The
cost is an `ADR-0018` residual (A230): until its opener closes, an open-web page an app opens this
way runs in the app's partition. The other direction is never allowed: a popup into an isolated
app from any other session opens as an ordinary tab in the app's own session, the only place its
pinned bundle is served (`ADR-0007`). A popup's app-tab flag follows its own URL, not its
opener's.

**`routePopup`'s `isApp` catches a gap `targetPartition === opener.partition` alone cannot see.**
A held grant alone puts no origin in its own partition (`ADR-0044`), so a granted,
network-served app and an ordinary site both commonly carry `partition: undefined` -- the two
would otherwise look identical to the partition comparison above, adopting a popup from any site
straight into a granted app's own window with `window.opener` intact. `isApp` (`routePopup`'s own
arg, `popupTargetIsApp` in `tab-view.ts`) checks the thing the partition check cannot: a held
grant or cache-served status, regardless of what partition either side happens to be on. It only
fires across a real origin change -- an app opening a popup to itself is unaffected.

**The same `isApp` question is asked again on did-navigate, not only at `routePopup` time.**
`routePopup` only ever sees the URL window.open() was given; a same-origin popup that later moves
ITSELF (`w.location = ...`) into a different, granted or cache-served app never goes through
`routePopup` again. `tab-view.ts`'s did-navigate handler re-asks `popupTargetIsApp` of the
committed URL (`openerCutNeeded`), and rebuilds the view when it answers yes and the opener's own
origin differs -- even when the partition string is not actually changing (two granted,
network-served apps both carry `partition: undefined`), since a freshly built WebContents is the
only thing that drops `window.opener` at all. This is also the one case `keepsOpenerSession`
exempts: the opener link is exactly what must not survive here.

**[`leave-page-prompt.ts`](leave-page-prompt.ts): closing a tab never asks.** `closeTab()`
closes the webContents without running `beforeunload` (A231).

**[`user-agent.ts`](user-agent.ts): the string, not the brand list.** `navigator.userAgentData`
lists Chromium rather than Google Chrome, and Electron has no API to change it. Google's sign-in
hosts (`accounts.google.com`, `accounts.youtube.com`) reject that, so on those two hosts alone the
browser presents as Firefox, which has no `navigator.userAgentData` and sends no `Sec-CH-UA*`
headers: [`sign-in-identity-headers.ts`](sign-in-identity-headers.ts) rewrites the request headers,
[`sign-in-identity-tab.ts`](sign-in-identity-tab.ts) swaps `navigator.userAgent`, and
`../../preload/sign-in-identity.ts` deletes `navigator.userAgentData` at document start. The
preload runs in a tab's main frame only, so a sign-in page in another site's iframe keeps it.
