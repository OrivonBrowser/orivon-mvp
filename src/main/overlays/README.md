# `src/main/overlays/`: Orivon HTML above the page

**What lives here.** The facility a feature uses to show a panel, bar or sheet over the tab area
without building a preload, a channel or a renderer entry of its own. One preload
([`../../preload/overlay.ts`](../../preload/overlay.ts)), one renderer entry
([`../../renderer/overlay/`](../../renderer/overlay/)) and one registry per side: a feature adds
an `OverlayDef` to [`overlays.ts`](overlays.ts) and a page to
`src/renderer/overlay/pages.ts`.

| File | Job |
|---|---|
| `overlay-types.ts` | `OverlayDef`, `OverlayHost`, placements and close reasons: the contract a feature writes against |
| `overlay-bounds.ts` | Pure geometry: where an overlay sits, and how tall it may be; `dockBounds` for the strip beside the page |
| `overlay-ipc.ts` | The one channel a page speaks on, with its sender check |
| `overlay-view.ts` | One `WebContentsView`: construction, background, navigation lock, focus |
| `overlay-host.ts` | Per window: when a view exists, where it sits, when it closes, where focus goes |
| `overlays.ts` | `OVERLAYS`, the registry of every feature's `OverlayDef` |
| `tab-slots.ts`, `install-tab-slots.ts` | `requestSlot`: which surface a tab shows in its two places, a sheet over the page and a prompt under the address pill, so two never stack and a question waits for its tab |

**Tied to Electron.** `overlay-view.ts` and `overlay-host.ts` import `electron` values;
`overlay-types.ts`, `overlay-bounds.ts` and `overlay-ipc.ts` need only its types. The types and
the geometry are the part that survives a change of shell.

**What it depends on.** `electron`, `../channels.ts`, `../shell/` (`renderer-entry.ts`, `context-menu.ts`,
`lock-navigation.ts`, `shell-session.ts`, `theme-colors.ts`, `view-background-test-hook.ts`,
`window-context.ts` and the `Bounds` type). `overlays.ts` imports each feature's definition; nothing else here does.

**What it must never import.** A feature. A feature imports `overlay-types.ts` and is listed in
`overlays.ts`; nothing in this directory reaches into one.

**Owner stream.** `shell`.

## Design notes

**A dock is sized by the window, never by its content.** `{ kind: 'dock' }` takes the strip of the window the
page area leaves free (`dockBounds`: the page area's x says which side), full height. The host ignores the page's
height reports for it and repositions it on every layout instead of closing it (`closeOn.layout: false`); the
handler's optional `moved` runs after each reposition, so a feature that lays something over the dock follows it.
A dock has square corners. The side panel is the one dock.

**Beside the overlays, the host closes two legacy panels.** The permissions and site-info popovers
stay on `../permissions/popover-view.ts` and are handed to the host with `adopt`, so a tab switch, a
resize or the window closing dismisses them with every overlay, and showing a popup closes them.
`close()` with no name closes popups and adopted panels; `closeOverlays()` closes the popups alone,
for a panel that toggles itself straight after. `relayout()` closes an adopted panel every time, so
its `close` must be idempotent. `popupOpen()` counts an adopted panel that is open as a popup, so a
feature that must not open over one (the downloads peek) sees it.

**A toggle leaves an overlay whose handler holds.** `holdsOnToggle()` true (the site prompt while it
asks a question) makes a toggle of that name do nothing: a button that shares the name (the
site-access chip opens the same overlay to review) must not end an unanswered question as a dismissal.

**A bar or a sheet belongs to the pane in front.** An `area` placement (the find bar, a sheet, a card) is laid
out in `paneArea()`, the pane of the tab in front when the window is split, so it sits over the page it is
about; a dock and an anchored popup keep the whole tab area.

**An anchored overlay follows its anchor.** `reanchor(name, anchor)` places an open overlay under the
control again and runs its `moved` hook. Asks shown through `tab-slots.ts` are placed again whenever
the chrome reports that the address pill moved (`slotAnchorsMoved`), so a prompt under the pill stays
under it through a resize.

**A page's stylesheet is imported by its page.** `import './<name>.css'` in the page module is
bundled into the overlay entry's one stylesheet, and every rule sits under
`body[data-overlay='<name>']`. `src/renderer/overlay/surface.css` paints the page's own surface with
the same colour main sets before the page loads (`../shell/theme-colors.ts`), so the two cannot
disagree about the theme; a change to one changes the other.

**The keys work inside an overlay without wiring.** `install-shortcuts.ts` puts the dispatcher on
every window view, and an attached overlay view is a child of its window, so the shortcut owner is
found the same way as for the chrome.

**A handler is told when its window is gone.** `closed('window-closed')` reaches only an overlay
that was open; `disposed` reaches every attached handler, so one that subscribed to a service that
outlives the window drops the subscription there.

**An overlay is a view of its own, never a region of the chrome view.** The chrome view is exactly
as tall as the chrome and Electron honours a transparent view only inside a transparent window,
which the shell's is not; see [`../permissions/popover-view.ts`](../permissions/popover-view.ts).
The permissions and site-info popovers stay on that file.

**The host builds nothing until asked.** Every window would otherwise carry a hidden renderer
process nobody may open. `show` and `prewarm` build a view; a `fresh` overlay is destroyed on
close and a `warm` one keeps its view, and its last reported height, for the next show, but
destroys it after a minute closed (a prewarmed view never shown goes the same way). A `resident` one
keeps its view for the life of the window: the address bar's suggestions are typed into the moment
they open and never wait for a renderer to start.

**A page asks for its first show, and is told the rest.** The page calls `ready` once mounted and
the reply carries the show result that was waiting, so nothing is sent to a page that has no
listener yet. Later shows of a warm view arrive as a `show` message. Events sent through
`overlays.send` before `ready` is answered are held (up to 32) and travel in that reply, after
the show, so a page that starts afresh on a show never loses one.

**Security sits in `overlay-ipc.ts`.** The handler is registered on the view's own `webContents.ipc`
and answers only that view's main frame at the exact address main built. A view can reach only the
handler of the definition it was built from, because the port closes over the slot. A handler's
`request` is untrusted input from a page: it validates every field. A failure inside one is logged,
never returned. Why one shared preload is safe, and what a compromised overlay page can reach:
[`ADR-0048`](../../../docs/decisions/ADR-0048-orivon-s-own-overlays-share-one-host-and-one-preload-bridge.md).

**Focus.** A `take` overlay remembers what held focus, if it belongs to this window (its chrome or
the tab in front), and gives it back on close, except when the
person clicked into the page (`blur`, where the click already chose) or the tab changed (the new
active tab gets it). A `never` overlay hands focus straight back if a click gives it any, to what
this window holds now; the chrome keeps the keys and drives it through `overlays.send`. A `take`
overlay shown in a window while another window of the app has focus does not take it. A `never` overlay that
shows a text box asks for the keyboard from its handler (`takeFocus`) on the first click into it, and from then
on behaves as `take` until it closes.

**Blur closes on the same mousedown that a re-click on the opener uses to ask again.** That click's
message reaches main after the blur, and a button held down delays it by as long as it was held. The
toolbar's menu button, and every toolbar button that toggles an overlay (the shared toolbar button's `presses`
option, named by the overlay), therefore announces its press (`press` command), main stamps it with its own clock,
and `toggle`'s `pressedAt` is that stamp: the toggle is the echo when the blur-close happened at or after
the press, however long the press lasted, and a fresh request when the close was earlier. The page's clock
is never compared with main's, which drift apart over a suspend. A toggle with no stamp (a key, or a toggle main
asked for itself) is the echo when it comes within 300 ms of a blur-close. The rule is
`isEchoOfClose` in [`../shell/press-stamps.ts`](../shell/press-stamps.ts), shared with the popups in
[`../permissions/`](../permissions/).
