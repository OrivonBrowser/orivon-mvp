# `src/main/tab-search/`: find an open tab by typing

**What lives here.** The list behind `Mod+Shift+A`: every open tab of every window of this process, then the
tabs and windows closed lately. `tab-search-model.ts` turns the windows' state and the closed stack into rows,
`tab-search-overlay.ts` declares the overlay and runs what the page asks for (go to a tab, close one, reopen a
closed entry) while keeping an open list current, `tab-search-requests.ts` checks each request, and
`recency.ts` remembers which tab was in front last. The page is
[`../../renderer/overlay/tab-search/`](../../renderer/overlay/tab-search/), the button that opens it is
[`../../renderer/chrome/tab-search-button.ts`](../../renderer/chrome/tab-search-button.ts), and the command
is `tab.search` in [`../shortcuts/`](../shortcuts/).

**What it depends on.** [`../overlays/`](../overlays/) (`overlay-types.ts`); [`../shell/`](../shell/) (the
window registry, tab lifecycle and state types); [`../session-restore/`](../session-restore/) (the closed
stack and the entry type); `electron` as a type in `recency.ts`.

**What it must never import.** The renderer, or a value from the rest of the shell beyond the types above:
the shell lists this feature (`overlays/overlays.ts`, `shortcuts/run-command.ts`), not the other way round.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron only through the overlay host it is declared to. The model, the
request check and the recency order take plain values.

## Design notes

**Main sends the rows unranked; the page ranks them.** Matching is local to the typing and needs no round
trip, so the page holds the rows and the query and only asks main to act. Rows arrive in the order an empty
query shows: tabs most recently in front first, the tab the person is on last (it is where they already
are), then the newest closed entries.

**The order needs a history, so it is kept from the first time the list opens.** `Recency` subscribes to tab
activations when the list is first shown; a tab never seen in front keeps its strip order after those that
were. Tab ids are unique across the windows of a process, so one map serves all of them.

**The list stays open when it closes a tab, and leaves on any other tab switch.** Closing the active tab makes
another one active, which would close an ordinary popup. The overlay therefore does not close on a tab switch
itself: it closes on an activation in its own window unless the list caused it.

**Everything a page can name is looked up, never trusted.** An id that no window holds, and an entry that is
no longer on the closed stack, do nothing. A favicon is passed on only as an image data URL under a size cap,
and all of one list under a budget, so a show stays small however many tabs are open.

**A private session lists only itself.** It is a separate process with its own windows and its own closed
stack; nothing of the ordinary session reaches it, and nothing of it is written anywhere.
