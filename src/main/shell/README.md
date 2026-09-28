# `src/main/shell/`: the window, and the views inside it

**What lives here.** `window.ts` composes the frameless `BaseWindow`: a chrome view on top, the
active tab's `WebContentsView` below, or the two panes of a split. A process holds any number of these
windows: `shell-services.ts` is what they share, and `window-registry.ts` is how a page's IPC finds the
window holding it. `window-frame.ts` is the native window itself and `window-options.ts` says how a new one
opens. `tabs.ts` owns the tab collection, with `tab-view.ts`, `tab-types.ts` and `tab-factory.ts` as its
parts. `tab-order.ts` is where a tab sits in the strip, `tab-move.ts` moves one between windows keeping the
same page, `tab-menu.ts` is its right-click menu, and `window-actions.ts` is what the chrome's buttons and
menus ask of their window. Split view: `split-model.ts` is the arithmetic and the groups of joined tabs,
`split-controller.ts` plans which views show where, `pane-host.ts` puts them on screen in that order,
`split-frame.ts` is the view behind two panes, and `split-drop.ts` says where a dragged tab would split the
page. `intro-state.ts` and `intro-view.ts` are the welcome screen.
The rest answer what a page asks of its window: popups become tabs, HTML fullscreen, the
few-second exclusive-access notices, the `beforeunload` Leave/Stay question, the external-link
and notification questions the permission gate asks, the right-click menu for tabs and the
chrome, and the plain Chrome User-Agent every page sees. `lock-navigation.ts` refuses every navigation
and popup on a view that must stay on the document it was created for: the chrome view and its
popups, whose privileged preload would follow any navigation, and
[`../sessions/web-context-host.ts`](../sessions/web-context-host.ts)'s isolated context, which
has no preload but is confined to one origin (ADR-0019).

The main menu under the toolbar's menu button: `menu-layout.ts` lists which commands it shows (the
names and keys come from [`../shortcuts/`](../shortcuts/), so the menu cannot show a key that does
not work), and `menu-panel.ts` is the popover that shows it, built on
[`../permissions/popover-view.ts`](../permissions/popover-view.ts) like the two other toolbar popups.

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
[`../verifier/`](../verifier/), plus the top-level `channels.ts` and `registry.ts`.

**What it must never import.** [`../../renderer/`](../../renderer/) code (the repo-wide rule).
Locally: [`tab-view.ts`](tab-view.ts) and [`tab-types.ts`](tab-types.ts) must never import
[`tabs.ts`](tabs.ts); they were split out of it so the pure parts have no `TabManager` state to
depend on.

**Durable or tied to Electron.** Tied to Electron throughout: every file here exists to drive
`BaseWindow`, `WebContentsView` or `dialog`.

**Owner stream.** `shell`, build step 1, **done**. Maintenance only.

## Design notes

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

**[`tab-view.ts`](tab-view.ts): a view leaving an app's partition is parked, not closed.** A
page's `sessionStorage` lives in its view, not its partition (measured in Electron 44), so a
fresh view would break an OIDC login that keeps its state there while the provider has the tab.
Only app partitions are parked; the open-web side of a swap still loses its history.

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

**[`leave-page-prompt.ts`](leave-page-prompt.ts): closing a tab never asks.** `closeTab()`
closes the webContents without running `beforeunload` (A231).

**[`user-agent.ts`](user-agent.ts): the string, not the brand list.** `navigator.userAgentData`
still lists Chromium rather than Google Chrome, and Electron has no API to change it.
