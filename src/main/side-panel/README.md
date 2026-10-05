# `src/main/side-panel/`: the side panel docked beside the page

**What lives here.** A column beside the page, below the toolbar, on either side of the window, that lists
bookmarks, history, a reading list that nothing fills yet and downloads while the person browses, and holds one view an extension
supplies. The panel's own page is the `side-panel` overlay (a dock, see [`../overlays/`](../overlays/));
the page area shrinks by the panel's width, in `tabBounds()` of [`../shell/window-layout.ts`](../shell/window-layout.ts).

| File | Job |
|---|---|
| `side-panel-model.ts` | Pure: the width limits, `clampWidth`, `fits`, `insetsFor` |
| `side-panel-store.ts`, `side-panel-stores.ts` | `<userData>/side-panel.json` (width, last view); memory for a private session |
| `panel-types.ts`, `panel-views.ts`, `views/` | A view is a function from a query to rows; one file per view |
| `panel-requests.ts` | The few requests the page may send, each field checked |
| `row-menu.ts`, `row-menu-runner.ts` | A row's native menu (open in a tab or window, copy the link, delete) and the two Electron calls it needs |
| `side-panel-overlay.ts` | The overlay's definition and its handler |
| `side-panel-host.ts`, `side-panel-guests.ts` | One panel per window and the guest slot; entries and choice listeners for the whole process |
| `side-panel-pane.ts` | The panel as a stop of the F6 order (`EXTERNAL_PANES`) |
| `side-panel-hook.ts`, `install-side-panel.ts` | Gives a window its panel; makes the file store |

**What other code uses.** `sidePanelFor(window)` answers `isOpen`, `open`, `close`, `toggle`, `view`, `width`,
`side`, `bodyBounds`, `canShow` and `onChange`, and the guest slot: `setGuest({ id, title, icon?, view, closed? })` lays a
`WebContentsView` over the body below the header, above the panel and under every popup, and `closed` runs once
when it leaves. `setGuestEntries(entries)` adds `ext:<id>` entries to every window's picker, and
`onGuestChosen(listener)` hears a picker choice, `open(entryId)` or `toggle(entryId)`; the listener owns the view
and answers with `setGuest`. The answer is for the entry the panel is showing: once the person has picked another
view, or while the panel is closed, a late `setGuest` is dropped and its `closed` runs at once. The guest steps aside
while the view picker's list is open, since it sits above the panel's page. All of it is main-side: the page can only
choose an entry the list holds. `canShow()` says whether the window could show a panel now (not a kiosk, wide enough,
not stopped): a caller that must not fail silently asks it before `open`. `setGuest(null)` for an entry that was chosen
while nothing answers for it puts the panel back on the last of Orivon's own views, so the body is never left blank.

**Who fills the slot.** Extensions do, through [`../extensions/side-panel-runner.ts`](../extensions/side-panel-runner.ts):
it lists every extension holding `sidePanel` with a panel for the tab in front, and answers a choice with the
extension's page once its first load has ended.

**Tied to Electron, entirely.** The model, the requests and the views' row building import no `electron` value;
the host, the overlay and the store do.

**What it depends on.** `electron` (types), [`../overlays/`](../overlays/), [`../shell/`](../shell/) (types, the
open-bookmark helper), [`../page-tools/`](../page-tools/) (the toast), the bookmark, history and download services through `ShellServices`.

**What it must never import.** The renderer, or a value from [`../shell/tabs.ts`](../shell/tabs.ts).

**Owner stream.** `shell`.

## Design notes

**Open state is per window and is not restored; the width and the last view are per profile.** A new window
starts closed. A window narrower than 760 px has no panel and its button is disabled; widening it brings back a
panel that was open. In HTML fullscreen and in a kiosk the page area takes the whole window and the panel is
hidden, with its overlay kept at zero width, so no state is needed to bring it back.

**A row's address comes from a store, never from the page.** The page sends a view id and a row id; the view looks
the id up in its own store and the address passes `sanitizeDirectUrl` again before anything opens.

**The resize edge reads screen coordinates and keeps its pointer captured.** The panel's view moves under the
pointer as the width changes, so a position in the view's own coordinates would feed back; a captured pointer keeps
delivering moves over the page's view. Main applies at most one layout per turn of the event loop however fast the
page asks.

**The guest is not a popup.** It is registered with the overlay host's `adopt` with a `close` that does nothing,
so a tab switch or a resize never closes it, and its restack lifts it directly above the panel's own view.
`bodyBounds()` stays clear of the resize edge on the page side so the edge can be grabbed under a guest.
