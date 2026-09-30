# `src/main/shell/bookmark-bubble/`: the bookmark bubble and "Bookmark all tabs"

**What lives here.** The small editor under the star and the sheet for saving every tab. `edit-model.ts` (pure: what
the bubble shows, each command a page may send and what it does to the store, the dated folder name, which tabs are
saved); `edit-overlay.ts` (the two overlay declarations, `bookmark-edit` and `bookmark-all-tabs`, and what each
accepts); `open-edit.ts` (opening them: the star command, the bubble for a page, a bar item or a folder, the sheet);
`edit-action.ts` (the chrome's `bookmarks.edit` call, which carries the star's rectangle); `bubble-state.ts` (the
folder used last, and the bookmark made a moment ago so its bubble says "added"). The page is
`src/renderer/overlay/bookmark-edit/`, the star's chrome module `src/renderer/chrome/bookmark-star.ts`.

**Tied to Electron.** Only through the overlay host: `edit-overlay.ts` is an `OverlayDef`. The rest is plain
TypeScript over `BookmarkStore` and `ShellWindow`, and would outlive a change of shell.

**What it depends on.** [`../../browsing/`](../../browsing/) (`bookmarks.ts`, `bookmark-types.ts`),
[`../../overlays/overlay-types.ts`](../../overlays/overlay-types.ts), `../chrome-actions.ts` (the action type),
`../shell-events.ts`, `../tab-types.ts`, `../window-context.ts`, `../window-registry.ts` (types).

**What it must never import.** `../tabs.ts` or `../window.ts`: a window is reached only through the
`{ window, services }` pair. Nothing here writes a bookmark from an address or title the overlay sent.

**Owner stream.** `shell`.

## Design notes

**The address and title of a new bookmark are the tab's own, read in main.** The overlay sends ids, names and folder
ids. Each command names the bookmark or folder the bubble was opened for, and main refuses one that names another, so
a page in the overlay can change only what it was shown. A folder must be the bar, Other bookmarks or a folder under
either; the reading list is refused.

**Mod+D and the star never remove a bookmark.** On a page that is not saved they save it in the folder used last (the
bar at first) and open the bubble titled "Bookmark added"; on a saved page they open "Edit bookmark" and change
nothing. Remove is the bubble's own button, and it removes the one bookmark the bubble was opened for when several
share an address. Dismissing the bubble keeps the bookmark: a name and a folder are saved as they change, one request
per keystroke, because a blur closes the view before any pause could run out.

**The chrome only says where the star is.** `bookmark.toggle` makes the bookmark in main and sends the chrome a
`bookmark-star` event; the module answers with `bookmarks.edit` and the star's rectangle, because only the chrome
knows it. A click on the star sends the same call with `add` and `toggle`, so a second click closes the bubble.

**A new folder is made when Done is pressed, not before.** Choosing "New folder…" swaps the select for a name field;
a bubble dismissed in that state keeps the bookmark where it was and makes no folder. The folder modes ("Rename
folder", "New folder") and the all-tabs sheet save on their button and do nothing when dismissed.

**The last folder is remembered in memory only.** Keeping it across restarts would put a field in `bookmarks.json`,
which is the store's format to change; until then a launch starts again at the bar.

**"Bookmark all tabs" saves in one store change.** The sheet shows a count, but the save reads the window's tabs again
in main and creates the dated folder and its bookmarks with a single `importTree`, so the bar updates once.
