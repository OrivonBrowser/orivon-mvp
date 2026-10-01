# `src/main/find/`: find in page

**What lives here.** The find bar and what it does to the page. `find-session.ts` is one tab's search
state as pure functions (what to ask next, which answers to believe). `find-runner.ts` makes the calls
on a tab's `WebContents`. `find-window.ts` is one window's bar: its per-tab sessions, the answers, a
navigation under an open bar, a tab switch. `find-overlay.ts` declares the bar as an overlay;
`find-commands.ts` is what `find.open`, `find.next` and `find.previous` run; `find-events.ts` holds
the messages between main and the bar's page, and the check on each request. The page is
[`../../renderer/overlay/find/`](../../renderer/overlay/find/), and the tab's own events reach the bar
through [`../shell/signals/find.ts`](../shell/signals/find.ts).

**What it depends on.** `electron` (types, and `WebContents` calls in `find-runner.ts`);
[`../overlays/`](../overlays/) (`overlay-types.ts`); [`../shell/`](../shell/) (`window-registry.ts` and
`window-context.ts`, types only).

**What it must never import.** The renderer, or a value from the rest of the shell: the shell lists this
feature (`signals/find.ts`, `shortcuts/run-command.ts`), not the other way round.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron: `findInPage`, `stopFindInPage` and the `found-in-page` event
are its find API. `find-session.ts` and `find-events.ts` need nothing of it.

## Design notes

**The bar belongs to the window's active tab, and main picks the tab.** The page never names one: every
request is resolved against the active tab at the moment it arrives, and ignored if that is not the tab
the bar was opened on. A tab switch closes the bar and clears the tab's highlights; the tab keeps its
query and gets the bar back when it is active again.

**An answer is believed only if it is the newest.** `findInPage` returns an id and every answer carries
one, so an answer to "or" that arrives after "ori" was typed is dropped here, before the page sees it.
Typing searches on every keystroke with no debounce for that reason.

**Escape and the close button keep the page's selection on the active match.** Every other close
(a tab switch, a navigation) clears it. The last query is kept per window in memory and is never written
anywhere, a private window included.

**A navigation blanks the count and searches again once the page stops loading.** The old page's matches
are gone, so the next call begins a new search.

**The bar's focus is the overlay's.** It takes focus on show, and pressing the find key while it is open
shows it again, which is how it takes focus back and selects its text.
