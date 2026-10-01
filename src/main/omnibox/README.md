# `src/main/omnibox/`: what the address bar offers while someone types

**What lives here.** The rows under the address bar and what finishing the text means. `suggest.ts` is the
ranking (pure), `suggest-sources.ts` reads the bookmarks, the history and the open tabs into scored rows and
lists the sources that wait, `suggest-fetch.ts` (with `suggest-parse.ts`) is the one of those that asks the default
engine for suggestions, `verbatim-row.ts` is the first row ("Go to address" or "Search
<engine>", decided by the same classifier Enter uses), `omnibox-service.ts` holds one window's rows and what
choosing one means, `omnibox-window.ts` hands that service the window's stores, `omnibox-actions.ts` is what the
chrome asks (`omnibox.query`, `select`, `pick`, `close`) and what a choice does to the window, and
`omnibox-overlay.ts` declares the dropdown, drawn by
[`../../renderer/overlay/omnibox/`](../../renderer/overlay/omnibox/) and driven by
[`../../renderer/chrome/address-suggest.ts`](../../renderer/chrome/address-suggest.ts). `omnibox-names.ts` holds the
two names they share. `suggest-net.ts` binds the request to `net.fetch`, and `suggest-test-seam.ts` lets a test build
point it at a local fixture.

**Tied to Electron only in** `omnibox-overlay.ts`, `omnibox-actions.ts` and `suggest-net.ts`, through the overlay host and the
window they are given. The ranking, the sources, the service and the first row take plain values.

**What it depends on.** [`../overlays/`](../overlays/) (`overlay-types.ts`); [`../shell/`](../shell/) (the window
context, the chrome actions, the tab state); [`../history/`](../history/) and [`../browsing/`](../browsing/) (types
and the address classifier); [`../pages/`](../pages/) (own pages and the names other browsers give them are opened before anything is classified); [`../page-tools/`](../page-tools/) (`view-source.ts`).

**What it must never import.** The renderer, or a network module other than `suggest-net.ts`: what is typed leaves
the process only through `suggest-fetch.ts`, and only while every guard in its `mayRequest` holds.

**Owner stream.** `shell`.

## Design notes

**The chrome keeps the keys and the focus; the overlay never takes it.** The field is where the person types, so
arrows, Enter and Escape are handled on the field, and the overlay is told the rows and the selected one. A
mouse press on a row is taken on the press rather than the click: the field blurs to the overlay on the press,
and the chrome closes the list on blur (after a short wait a refocus cancels).

**Main holds every address.** The page and the chrome send an index and, if they have one, the number of the list
they saw; an index outside the held list, or a number that is not the current one, does nothing. Nothing a page
supplies is ever opened.

**Finishing the text is a property of typing, not of the field's value.** Main finishes only when the chrome says
the text was just typed (a character at the end, after a printable key, no composition), so a filled or pasted
address loads exactly as it is. The setting `addressBar.autocomplete` turns the finishing off, not the list.

**The row the text finishes to stands for the address the field then holds.** A host finished from a deeper page
is listed as the host, and the deeper page stays a row of its own; the row is a bookmark or a history page only
when the whole address was finished from it.

**An address typed in full is counted once its page is recorded.** `omnibox.close` with what was submitted counts it
(`pages.typed_count`), behind the visit it belongs to, since the visit is recorded after the page commits.

**Open tabs are offered across windows, the tab being used and blank tabs excepted.** Choosing one activates it in
its own window and closes the empty tab the choice was made from.

**Engine suggestions are the one place typed text leaves the machine before Enter.** They are off until the person
turns on `search.suggestions`, never asked for in a private session, and asked only for text Enter would send to the
default engine as typed: not an address, not a page of the shell, not a keyword search, not a forced `?` search, two
to 200 characters. The request goes to the engine's own https address with no cookie, no referrer and no redirect,
after 150 ms without typing, and is cancelled by the next keystroke; the answer is read up to 64 KB and cut to four
strings of at most 200 characters with control and direction characters removed. Only a built-in engine has an
address (`SEARCH_ENGINES` in [`../browsing/search-engines.ts`](../browsing/search-engines.ts)), so a person's own
engine never gets one. The rows join after row 1 as late rows and never move the selected one.
