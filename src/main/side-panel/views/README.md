# `src/main/side-panel/views/`: what each side panel view lists

**What lives here.** One file per view the panel's picker offers: `bookmarks.ts` (the bar's tree and Other bookmarks, a
flat list while searching), `history.ts` (the newest 200 visits by day), `reading.ts` (the bookmark file's reading-list
root, which nothing fills in this build) and `downloads.ts` (name, state and progress). A view is a `PanelViewDef`
(`../panel-types.ts`): rows for a query, the address a row opens, what opening and deleting do, and which store change
should refresh it. [`../panel-views.ts`](../panel-views.ts) lists them in picker order.

**Tied to Electron, no.** A view reads a service through `ShellServices` and returns plain rows.

**What it depends on.** `../panel-types.ts`, `../../browsing/omnibox.ts` (`sanitizeDirectUrl`) and the bookmark, history
and download services.

**What it must never import.** `electron`, a renderer, or a value from [`../../shell/tabs.ts`](../../shell/tabs.ts).

**Owner stream.** `shell`.

## Design notes

**A row carries an id, never an address.** The panel page sends a view id and a row id; the view finds the row in its
own store, and the address it opens goes through `sanitizeDirectUrl` again. A view that holds addresses from more than
one store checks the row's parent before it resolves or deletes it, so a row from the reading-list root cannot be
named through the bookmarks view.
