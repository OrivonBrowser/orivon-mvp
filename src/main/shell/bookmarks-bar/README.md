# `src/main/shell/bookmarks-bar/`: the bookmarks bar, main side

**What lives here.** What the chrome's bookmarks bar needs from main. `bar-items.ts` (the bar's children as the
chrome draws them, and whether the bar is shown) and `bar-visibility.ts` (reading and toggling that, for the window's
layout, the menu tick and `Mod+Shift+B`); `bar-state.ts` (the `bookmarked` field of `ShellState`, which the star
reads); `bar-actions.ts` (the chrome's calls: `bookmarks.bar`, `bookmarks.open`, `bookmarks.menu`, `bookmarks.move`,
`bookmarks.folder`); `bar-menu.ts` (the right-click menu as a native template, pure) and `bar-menu-runner.ts`
(builds it and pops it up); `folder-overlay.ts` and `folder-model.ts` (the folder menu overlay and what it lists);
`open-bookmark.ts` (opening an item in the tab, behind it, in a window or a private window, and Open all). The menu's
Edit…, Rename… and Add Folder… hand over to [`../bookmark-bubble/`](../bookmark-bubble/), which owns the bubble.

**Tied to Electron.** `bar-menu-runner.ts` (`Menu`, `clipboard`) and `folder-overlay.ts`, through the overlay host;
the rest is plain TypeScript over `BookmarkStore` and would outlive a change of shell.

**What it depends on.** [`../../browsing/`](../../browsing/) (`bookmarks.ts`, `bookmark-types.ts`, `omnibox.ts` for
`sanitizeDirectUrl`), [`../../overlays/overlay-types.ts`](../../overlays/overlay-types.ts), `../chrome-actions.ts`,
`../shell-state-parts.ts`, `../window-context.ts`, `../window-registry.ts` (types).

**What it must never import.** `../tabs.ts` or `../window.ts`: it reaches a window only through the
`{ window, services }` pair it is handed.

**Owner stream.** `shell`.

## Design notes

**The chrome holds the bar's items and nothing else.** The items travel to the chrome as a `bookmarks-bar` event
when the bookmarks change (and when a late icon fills one in), and a chrome that has just started asks for them with
`bookmarks.bar`; a state push carries only `bookmarked`. The favicons, which are most of the bytes, therefore cross
the process boundary once per change instead of once per tab event.

**Every action takes ids, and main looks the address up.** A payload is checked field by field, an id is resolved in
the store, and the address passes `sanitizeDirectUrl` again before a tab is made, so neither the chrome nor the folder
menu can make main open an address of its own choosing. "Open all" opens the pages directly in the folder, at most 25
and as many as the window has room for.

**A click on another folder switches menus; a click on the open one closes it.** An overlay closed by blur and the
click that caused it arrive together, so `folder-overlay.ts` remembers which folder a menu was dismissed from for a
moment: the same folder's click is that dismissal's echo, another folder's click opens its own menu.

**The bar's overflow menu is the folder menu over the bar's own list.** `bookmarks.folder` with `id: 'bar'` and a
`from` index lists the items that did not fit; it has no "Open all".
