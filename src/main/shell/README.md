# `src/main/shell/`: the window, and the views inside it

**What lives here.** `window.ts` composes the frameless `BaseWindow`: a chrome view on top, the
active tab's `WebContentsView` below, or the two panes of a split. A process holds any number of these
windows: `shell-services.ts` is what they share, and `window-registry.ts` is how a page's IPC finds the
window holding it. `window-frame.ts` is the native window itself and `window-options.ts` says how a new one
opens. `window.ts` is the composition; its parts are `window-layout.ts` (where the chrome and the page
area sit: the one place a page area is computed), `window-state.ts` (the `ShellState` push, and which
overlays a tab switch or a navigation dismisses), `window-panels.ts` (the permissions and site-info
popovers, and the extension popup's panel for the overlay host) and `shell-state-parts.ts` (the `ShellState` fields a feature adds; `state/update-offered.ts` is the one that lights the key icon's dot while the page in front has an update offer, and `pre-partition.ts` stops a link or redirect into a cache-served address before it commits so the pinned files answer, `ADR-0056`). `window-context.ts` is
the `{ window, services }` pair a hook or an overlay handler receives.
`tabs.ts` owns the tab collection, with `tab-state.ts` (the state a tab reports, plus what each
`TAB_SIGNALS` entry adds), `tab-navigation.ts`, `tab-open.ts` (every way a tab is created) and
`tab-panes.ts` (which views show where) as its parts; `tab-view.ts`, `tab-partition.ts`,
`app-tab-watch.ts`, `tab-signals.ts`, `tab-types.ts`, `tab-factory.ts`, `tab-lifecycle.ts` and
`tab-parking.ts` are the per-tab view; `load-in-tab.ts` is the one test that opens an address in the tab's own view or in a view of the session it needs, shared by the address bar and a link followed inside a tab. `eth-gateway-redirect.ts` opens an ENS gateway address (`<name>.eth.limo`, `<name>.eth.link`) as the `.eth` name it stands for: the web-request handler, which shares the rule in `eth-gateway-rule.ts` (`gatewayRedirectFor`, `gatewayEntries`; no `electron`) with the tab hooks below. `tab-origin-liveness.ts` is `tab-view.ts`'s own per-origin
live-document counter. A local file's tab is always in a local-files session ([`../local-files/`](../local-files/)): `tab-partition.ts` routes it there, `tab-factory.ts`'s `localFile` makes it, and the `did-navigate` swap moves a tab that reached a file by history. `tab-order.ts` is where a tab sits in the strip, `tab-move.ts` moves one between windows keeping the
same page (and is where a dragged tab's cross-window target -- which window's strip, and where in it -- is
worked out from the tab centres `strip-centres.ts` reads off the target window's chrome page, shared by the actual move and by `tear-drag.ts`'s own mark), `tab-menu.ts` is its right-click
menu (and `context-menu.ts` the menu a page gets: `page-menu-items.ts` is where the extension host adds its items, `context-menu-groups.ts` holds one function per group, `context-menu-text.ts` cleans what a page controls before it reaches a label, `paste-and-go.ts` is the address bar's clipboard submit), and `window-actions.ts` is what the chrome's buttons and menus ask of their window (`press-stamps.ts` stamps, with main's clock, the press on a popup's button so the click that follows is judged by it), and `chrome-actions.ts`
(with `actions/`) is where a chrome module's own call to main lands.
`attach-view.ts` is the one way a view goes into a window. `tab-drag-actions.ts` is what the chrome's tab drag asks of its window; `tear-drag.ts` is the floating preview a tab shows once torn out of its strip, and the mark it leaves on
whichever window's strip it is dragged over. Where a window cannot read the screen (a native Wayland session, `local-pointer.ts`) the browser's own drag and drop carries the tab instead: `native-tab-drag.ts` holds the drag in progress, `native-drag-plan.ts` is the pure rule for what a drop does, and `drop-catcher.ts` is the transparent view over a window's page while the drag lasts. Split view: `split-model.ts` is the arithmetic and the groups
of joined tabs, `split-controller.ts` plans which views show where, `pane-host.ts` puts them on screen in
that order, `split-frame.ts` is the view behind two panes, and `split-drop.ts` says where a dragged tab
would split the page. `intro-state.ts` and `intro-view.ts` are the welcome screen, and `new-tab-focus.ts` is where the keyboard goes after a new tab opens in front: the address bar, never the tab's own page (a window that lacks the OS focus is left alone, and so is one the welcome screen covers). `shell-installers.ts` runs each feature directory's installer at start, and `sheet-backdrop.ts` paints the shell's own surface colour behind a sheet that sits over a tab with no background of its own. `tab-backing.ts` picks a view's pre-paint colour when a navigation starts, and `window-backing.ts` keeps the window behind the views in the colour of the tab shown.
`first-window.ts` decides what a cold start opens (the window's last place, the addresses on the command line, a kiosk's page) and `home.ts` is what Home opens.
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
new-tab dashboard (a tab that happens to navigate to `orivon-shell://renderer/newtab/index.html`), stay on
`session.defaultSession`; the Design notes below say why.

The bookmarks bar's main side is [`bookmarks-bar/`](bookmarks-bar/) (its own README): what the bar shows, the
folder menu, the right-click menu and what opens a bookmark. The bubble under the star, which names and files a
bookmark, and the sheet for "Bookmark all tabs", are [`bookmark-bubble/`](bookmark-bubble/) (its own README).

The question panel: every question the browser puts to the person is asked through `question/ask-question.ts`'s
`askQuestion(target, spec, options)`, which resolves with the pressed button in the shape of Electron's message box.
`question/question-spec.ts` is the spec and the cleaning every string passes through (pure, no `electron`),
`question/question-overlay.ts` is the overlay and the map of questions main holds under random ids, and
`question/install-questions.ts` binds the ask to this process's windows. The panel is drawn in the window of the tab
the question belongs to, under the address pill with its top edge inside the toolbar; a background tab's question waits
for its tab, a kiosk draws it centred, and only a question asked when no shell window exists opens a native box.
`navigation-hold.ts` holds a tab's page where it is while a question about it is open (`holdNavigation`, nesting and
released once): `tab-view.ts` drops a main-frame navigation, a redirect and a `window.open` the page starts meanwhile, so
an answer cannot be given to a page that is no longer the one asked about. A change of address inside the document is
not a navigation and still works. `page-dialogs.ts` answers a page's own `alert`, `confirm` and `prompt` (it replaces the one handler
Electron keeps on a tab's internal dialog event for `alert` and `confirm`, and takes `prompt` from the tab's preload, which blocks on a send;
it replies once the person has answered in the panel, or with the dismissed default when the tab navigates; a closed tab is answered as dismissed while its frame is alive; a dead renderer, Electron's cancel event or a removed frame close the panel and send no answer, because the callback for a gone frame crashes the browser process), and `signals/crashed.ts` does not call a page blocked on one unresponsive.
`leave-page-prompt.ts` keeps a page that asks "Leave this page?" where it is while the panel asks, lets the next attempt
through after Leave, and runs again a navigation the shell started (`tab-navigation.ts` records it). `served-address.ts` loads an `ipfs:` link at the URL its protocol serves it at, and not
while the tab is held: a load from there is one the hold would never see.
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
[`../browsing/`](../browsing/), [`../extensions/extension-popup-host.ts`](../extensions/extension-popup-host.ts) (`window-panels.ts` adopts its panel), [`../ipc/`](../ipc/), [`../permissions/`](../permissions/),
[`../shortcuts/`](../shortcuts/) (the command table and the service the menu reads, and the command bus a window runs a chosen command through), [`../overlays/`](../overlays/) (the question panel is an overlay shown through the tab slots),
[`../consent/grant-prompt-origin.ts`](../consent/grant-prompt-origin.ts) (the origin line every
permission dialog shows), [`../sessions/`](../sessions/) (the two questions' types, and
`permission-gate.ts`'s notification store, handed to the permissions panel; `web-request-owner.ts` and `handler-while-needed.ts`, for `eth-gateway-redirect.ts`),
[`../dev/`](../dev/) (the developer-mode flag, the score-level override, the local resolvers),
[`../verifier/`](../verifier/), the stores and services a window reads ([`../settings/`](../settings/),
[`../history/`](../history/), [`../zoom/`](../zoom/), [`../devtools/`](../devtools/),
[`../pages/`](../pages/), [`../launch/`](../launch/)), [`../os/`](../os/) (the welcome screen's default-browser offer, `intro-view.ts`; the launcher menu and the default-browser ask are installers and a window hook the shell runs), [`../startup/`](../startup/) (the restore bar a window's hook offers, and the start-up plan the first window follows), plus the top-level `channels.ts` and `registry.ts`.

**What it must never import.** [`../../renderer/`](../../renderer/) code (the repo-wide rule).
Locally: [`tab-view.ts`](tab-view.ts), [`tab-types.ts`](tab-types.ts) and
[`tab-parking.ts`](tab-parking.ts), [`tab-partition.ts`](tab-partition.ts) and
[`tab-signals.ts`](tab-signals.ts) must never import [`tabs.ts`](tabs.ts): they are the per-tab view,
with no `TabManager` state to depend on.

**Durable or tied to Electron.** Tied to Electron throughout: every file here exists to drive
`BaseWindow`, `WebContentsView` or `dialog`.

**Owner stream.** `shell`, build step 1, **done**. Maintenance only.

## Design notes

**A tab drag where the screen is unknown is the browser's own drag and drop, with a catcher over each page.** On a native Wayland session a top-level window is told nothing of where it or the pointer is on the screen: Electron reports the global cursor at (0, 0), every window at one fixed place, and ignores the position asked for a window (a top-level window cannot choose its place there; popups are placed relative to their parent, and Electron 44 makes none of its windows a popup). `local-pointer.ts`'s `pointerIsLocal()` is the one switch; X11, Windows and macOS keep the pointer-capture drag. In an HTML drag the compositor draws the drag image anywhere, and each window sees `dragover` in its own coordinates, so a window marks the slot under the pointer before the drop (`docs/planning/wayland-window-placement.md` has the measurements). The drag carries one random nonce under one data type, never the tab's id or address, because a page under a drag is told the types it holds; a transparent `WebContentsView` over each window's page (`drop-catcher.ts`) takes the drag instead of the page, which sees no event at all. The catcher exists as a view only for the length of a drag; it is loaded when a press on a tab has moved 3 px and released after a minute unused. The chrome (`src/renderer/native-tab-drag.ts`) marks the slot in the strip the pointer is over, source strip included, and leaves the dragged tab as a gap. A drop reaches main as a report from the window that took it; `native-drag-plan.ts` decides: a strip reorders at the source and takes the tab in any other window; a split edge of the source's page splits; every other drop, and a drag that ends with nothing having taken it, opens a window of its own at the source's size, with no position; Escape changes nothing. Escape and a release over nothing look alike (`dragend` with no drop, `dropEffect` `none`); the only tell is a `keyup` Escape reaching the source 100 to 200 ms later, so a drop-less end waits 300 ms (provisional) for it. A Wayland drop needs one real pointer motion after the pointer entered the window, so a drop on a window the pointer just jumped into fails until it moves again. The browser starts a drag only when the pointer event that began it lies inside the chrome view, and a drag refused for that reason gets no `dragend` and leaves every later drag of the view refused too. So a press on a tab makes the chrome view twice the window's width and height for as long as the button is down (`window-layout.ts`'s `reachChrome`; its corner stays put, and it lies under the pages), which covers a quick flick down or to the right. The chrome page pins its root's width to the window's before main widens the view and lets it go once the view is back (`native-tab-drag.ts`), so the strip is not laid out again under the pointer and the pressed tab is the one dragged. The corner cannot move: the browser looks for the dragged element at the point where the press began, in the page's new layout, so a page shifted to stay in place has no tab there and no drag starts. While the pressed tab's pointer is outside the view, `tab-drag-blocked` (`styles/tabstrip.css`) turns dragging off for the whole chrome, so a flick out past the left or top edge does nothing until the pointer is back over it. The drop catcher is placed from the window's `chromeHeight`, not from the view's height. A drag the browser loses anyway is ended as cancelled at the chrome's next pointer event, and the tab stays where it was.

**`tab-view.ts`, `tab-partition.ts` and `tab-parking.ts` import each other.** Nothing in them runs
at module load across that cycle, so the order Node loads them in does not matter; keep it so, and
never use one of their exports at the top level of another.

**A tab's own state is a record and a list of signals, not a method on `TabManager`.** A feature that
needs per-tab state adds a field to `TabRecord` and `TabState`, and a `TabSignal` in
`tab-signals.ts` for what to watch on the `WebContents`; `tabClosing` in `tab-lifecycle.ts` tells it
when the tab ends and why. Each signal is a file under `signals/` (sound: `signals/audio.ts`); the
strip's order rules (pinned run first, a pair never split) live in `tab-order.ts`, and the things
done to one tab or to those around it in `tab-commands.ts`. `TabViewHost.services` and `runCommand` give code that runs on a view
(the context menu) the shared stores and the command bus.

**[`shell-session.ts`](shell-session.ts): the shell's own views never share a session with a
tab.** Chrome extensions load into `session.defaultSession`, the session every ordinary tab and
the dashboard use, and may act on `<all_urls>` there, so a privileged view on that session would
be reachable the same way. The dashboard is the one page of the shell on that session, and stays out
of their reach because no extension host pattern names the `orivon-shell:` scheme it loads from
(`../../broker/policy/extension-host-patterns.ts`). `SHELL_PARTITION` is `persist:` so a
privileged page may one day use `localStorage` without losing it; none does now.
`permission-gate.ts` and `verifier-subsystem.ts` cover the partition through
`app.on('session-created', ...)`, registered in `beforeReady` (`../subsystems.ts`), before
`createShellWindow` first creates it.

**[`shell-session.ts`](shell-session.ts) also names the renderer entries and where each is served.** A
built shell loads every entry from `orivon-shell://renderer/<path inside out/renderer>`, never from
`file:` (`renderer-entry.ts` builds the address; [`../pages/shell-scheme.ts`](../pages/shell-scheme.ts)
answers it). `SHELL_SESSION_ENTRIES` are served on `SHELL_PARTITION` with every file under `assets/`;
`DEFAULT_SESSION_ENTRIES` (the dashboard) on the default session, with only the files its own build
reaches, since a website shares that session. A page of the shell that is copied into another session
(a duplicated tab, a swap) does not carry its history entry: `tab-history.ts` drops entries on the
scheme, because no handler answers them there. `wireView` refuses a tab's navigation, frame or
redirect to the scheme.

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
fresh view and a lost history entry on every cross-origin link; it is open as A109. A swap within one
session (an origin newly registered as an app, an opener being cut, a typed address that flips the
app-tab flag) carries the back and forward list over with `NavigationHistory.restore`; a typed address
that has not committed loads after the pages up to the one being left. Only a swap across partitions
starts a new list.

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
opener's. A window a page
opens without the person's own click or key press is refused before any of this, by the pop-up blocker
in [`../site-settings/`](../site-settings/) that `PopupHost.popupBlocked` asks.

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
closes the webContents without running `beforeunload` (A231). A navigation does: Electron settles an unload from the
`will-prevent-unload` event and cannot be told later, so the page is kept, the question is asked in the panel, and Leave
lets the next attempt through. A navigation the page started is repeated by the person.

**[`user-agent.ts`](user-agent.ts): the string, not the brand list.** `navigator.userAgentData`
lists Chromium rather than Google Chrome, and Electron has no API to change it. Google's sign-in
hosts (`accounts.google.com`, `accounts.youtube.com`) reject that, so on those two hosts alone the
browser presents as Firefox, which has no `navigator.userAgentData` and sends no `Sec-CH-UA*`
headers: [`sign-in-identity-headers.ts`](sign-in-identity-headers.ts) rewrites the request headers,
[`sign-in-identity-tab.ts`](sign-in-identity-tab.ts) swaps `navigator.userAgent`, and
`../../preload/sign-in-identity.ts` deletes `navigator.userAgentData` at document start. The
preload runs in a tab's main frame only, so a sign-in page in another site's iframe keeps it.

**[`attach-view.ts`](attach-view.ts): a view goes into a window through `attachShown`, never a bare `addChildView`.** On
Electron 44 (X11 and Wayland alike) a `WebContentsView` that left a window and is added back stays hidden: its page
reads `visibilityState` `hidden` and never runs `requestAnimationFrame`, though it is attached, sized and focused. It
shows once the window's children change again, which `attachShown` does by adding a marker `View` and taking it out in
the same turn. A pane put *below* a pane that is on screen is not helped by that: it shows when the pane above it is
hidden and shown again in a later turn, which `attachShown` does for the views it is given in `above`. A page that
commits a document in a split can hide the pane beside it about ten milliseconds later; `pane-host.ts` therefore asks
each pane's page whether it is `visible` shortly after a pane goes on screen or commits, and hides and shows the
panes beside one that is not. A tab that is not in front is taken out of the window, which is wanted: Electron then
reports its page `visible`, and `tab-visibility.ts` (below) tells the page it is hidden instead. Playwright keeps every page it drives visible, so no spec sees any of this: `scripts/probe-view-visibility.mjs`
reads it with a debugger on the main process only, and `tests/attach-sites.test.ts` fails for an `addChildView` outside
`attach-view.ts`.

**[`tab-visibility.ts`](tab-visibility.ts) tells each page whether the person can see it.** A tab that is not in
front is detached from its window ([`pane-host.ts`](pane-host.ts)), and Electron never reports a detached view
as hidden, so its page would read `visible` and run at full rate for ever. `PaneHost` announces every change
of what is on screen through `TabLifecycle.shownChanged` (a tab in front, or the other pane of a split, is
shown); the module adds the window's own state (minimized, hidden) and sends the answer on
`TAB_VISIBILITY_CHANNEL` once per change and again after each main-frame navigation commits, because a new
document starts out visible. The page's preload turns it into `document.visibilityState`
([`../../preload/page-visibility.ts`](../../preload/page-visibility.ts)); the decision is in the
[decision log](../../../docs/decisions/decision-log.md). Limits: subframes are not told, and Chromium's
own throttling is not what slows a hidden page, only the page backing off when it reads `hidden`.

**[`eth-gateway-redirect.ts`](eth-gateway-redirect.ts): a gateway address opens as the `.eth` name from the first load, through four hooks and one handler.**
Setting `web3.ethGatewayRedirect` is on by default and applies at once; each hook asks `gatewayRedirectFor`, which answers
only while the setting is on and the verifier can load the name (`verifierServesName`), so with the light client off or unable
to start every gateway address opens as it is, except a developer-mode name or a test-build fixture, which the verifier serves without it. The hooks map the address before the load, so the tab's session, the fragment and the address
bar are those of the name from the start: `resolveTarget` in `tab-navigation.ts` (typed text, the dashboard box, paste-and-go, bookmarks,
Home), `TabFactory.content()` and `trusted()` (every new tab: middle clicks, links from other programs, startup pages, an
extension's `tabs.create`), `loadServedAddresses` in `served-address.ts` (a link followed inside a tab in an app's own session, which has no web-request owner, or inside a tab that must move to the name's session or app-tab
flag: `gatewayLinkTarget` in `load-in-tab.ts` answers only then,
and the link loads through the address bar's own session test), and
`windowOpenHandler` (a `target=_blank` link or `window.open` becomes a new tab or window, never a popup that loads the gateway in its
opener's session). The handler at order 5 on the default session's web-request owner, before HTTPS-only and extensions, catches what
the hooks leave to it: a link followed inside an ordinary tab (so a `location.replace`, a form's POST body and the referrer are kept), a server redirect to a gateway address (from a tab, or from a popup that keeps its opener), and back and
forward or a reload of a gateway entry saved while the setting was off. A restored tab and the copy of a sleeping tab map their
saved entries through `gatewayEntries` before the list is restored, since the view was built for the `.eth` name and can sit in a
session with no web-request owner. A fragment survives a server redirect (measured by
`test/web3/e2e-eth-gateway-redirect.test.ts`).
With the setting on a gateway address never commits, so the address bar and history show `ipfs://<name>.eth/...`; the omnibox's
"go to" row still shows the typed address. A link inside a tab that must move is loaded from `will-navigate`, which drops a
form's POST body and the referrer and makes a `location.replace` a new history entry, as for an `ipfs:` link. Limits: an
extension never sees the gateway address a person navigates to, since the redirect runs before extensions' request handlers and
the hooks map the address before any request exists, so a block an extension holds for an `eth.limo` host does not fire;
a `window.open` to a gateway address returns `null` and the new
tab has no opener, so a page that checks the handle or talks to the page it opened by `postMessage` does not work (an adopted
popup whose first address is the gateway itself never commits the redirect); the copy of a live tab keeps the gateway entries it
carried; a server redirect to a gateway address inside a cache-served app's own partition is not caught, since that
partition has no web-request owner; a name whose content Orivon
cannot load (Swarm, Arweave, not yet synced, unreachable) shows an error page, and turning the setting off is the way out;
data a site keeps under its gateway origin stays there and is not seen at the `.eth` name.
