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
| `overlay-bounds.ts` | Pure geometry: where an overlay sits, and how tall it may be |
| `overlay-ipc.ts` | The one channel a page speaks on, with its sender check |
| `overlay-view.ts` | One `WebContentsView`: construction, background, navigation lock, focus |
| `overlay-host.ts` | Per window: when a view exists, where it sits, when it closes, where focus goes |
| `overlays.ts` | `OVERLAYS`, every overlay the shell can show: the main menu (`../shell/menu-overlay.ts`), the find bar (`../find/find-overlay.ts`) and tab search (`../tab-search/tab-search-overlay.ts`) |

**Tied to Electron.** `overlay-view.ts` and `overlay-host.ts` import `electron` values;
`overlay-types.ts`, `overlay-bounds.ts` and `overlay-ipc.ts` need only its types. The types and
the geometry are the part that survives a change of shell.

**What it depends on.** `electron`, `../channels.ts`, `../shell/` (`renderer-entry.ts`,
`lock-navigation.ts`, `shell-session.ts`, `theme-colors.ts`, `view-background-test-hook.ts`,
`window-context.ts` and the `Bounds` type), `../shell/menu-overlay.ts` and `../find/find-overlay.ts` (listed in `overlays.ts`).

**What it must never import.** A feature. A feature imports `overlay-types.ts` and is listed in
`overlays.ts`; nothing in this directory reaches into one.

**Owner stream.** `shell`.

## Design notes

**Beside the overlays, the host closes two legacy panels.** The permissions and site-info popovers
stay on `../permissions/popover-view.ts` and are handed to the host with `adopt`, so a tab switch, a
resize or the window closing dismisses them with every overlay, and showing a popup closes them.
`close()` with no name closes popups and adopted panels; `closeOverlays()` closes the popups alone,
for a panel that toggles itself straight after. `relayout()` closes an adopted panel every time, so
its `close` must be idempotent.

**A page's stylesheet is imported by its page.** `import './<name>.css'` in the page module is
bundled into the overlay entry's one stylesheet, and every rule sits under
`body[data-overlay='<name>']`. `src/renderer/overlay/surface.css` paints the page's own surface with
the same colour main sets before the page loads (`../shell/theme-colors.ts`), so the two cannot
disagree about the theme; a change to one changes the other.

**The keys work inside an overlay without wiring.** `install-shortcuts.ts` puts the dispatcher on
every window view, and an attached overlay view is a child of its window, so the shortcut owner is
found the same way as for the chrome.

**An overlay is a view of its own, never a region of the chrome view.** The chrome view is exactly
as tall as the chrome and Electron honours a transparent view only inside a transparent window,
which the shell's is not; see [`../permissions/popover-view.ts`](../permissions/popover-view.ts).
The permissions and site-info popovers stay on that file.

**The host builds nothing until asked.** Every window would otherwise carry a hidden renderer
process nobody may open. `show` and `prewarm` build a view; a `fresh` overlay is destroyed on
close and a `warm` one keeps its view, and its last reported height, for the next show.

**A page asks for its first show, and is told the rest.** The page calls `ready` once mounted and
the reply carries the show result that was waiting, so nothing is sent to a page that has no
listener yet. Later shows of a warm view arrive as a `show` message. Events sent through
`overlays.send` before `ready` are held (up to 32) and delivered after it.

**Security sits in `overlay-ipc.ts`.** The handler is registered on the view's own `webContents.ipc`
and answers only that view's main frame at the exact address main built. A view can reach only the
handler of the definition it was built from, because the port closes over the slot. A handler's
`request` is untrusted input from a page: it validates every field. A failure inside one is logged,
never returned.

**Focus.** A `take` overlay remembers what held focus and gives it back on close, except when the
person clicked into the page (`blur`, where the click already chose) or the tab changed (the new
active tab gets it). A `never` overlay hands focus straight back if a click gives it any; the
chrome keeps the keys and drives it through `overlays.send`.

**Blur closes on the same mousedown that a re-click on the opener uses to ask again.** That click's
message reaches main after the blur, so a toggle within 300 ms of a blur-close is read as its echo.
