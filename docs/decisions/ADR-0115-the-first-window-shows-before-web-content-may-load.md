# ADR-0115: The first window shows before web content may load

- **Status:** accepted
- **Date:** 2026-11-20
- **Type:** architecture
- **Decided by:** owner for the goal (the browser on screen about a second after the click, on every start); AI recommendation for the order

## Decision

The first window is created and shown as soon as the registrations (`afterReady`) and the shell's stores exist. The slow
tail of every subsystem (`afterWindow`: the route's first read of the system's proxy settings, loading the person's
extensions, unpacking the bundled extensions into a new profile) starts when that window is created and runs while the
window loads and paints its page. The one step of it that holds the main thread, which serves that page, is the synchronous
unpacking of the bundled extension: it waits until the window is shown, or after a second if it has not been
(`firstWindowShown` in [`window-first.ts`](../../src/main/startup/window-first.ts)). When the tail has ended without a
critical failure, `openWebContent()` opens the gate on web pages ([`web-ready.ts`](../../src/main/startup/web-ready.ts));
then the first window is filled (the restored session, the addresses on the command line, What's new, the other windows of
a session), the session file is released, and only then is a second launch answered. A critical failure of the tail shows the error dialog and ends the process; the gate never opens.

Until the gate opens the window shows the new-tab page (or the page a private session opens on), or no tab when the plan
fills the window, and no tab, navigation or wake of a sleeping tab loads a page of the web: what asks waits and runs, in the
order it asked, when the gate opens. The shell's own pages never wait. While the plan's tabs are not yet open the session
file is held, so a start that ends early keeps the previous session.

## Context

Every start created its first window only after the whole tail had ended: the system proxy read (up to seconds on a PAC
script), and on a new profile a synchronous unpack of uBlock Origin's 781 files (1.7 to 3.5 s). A person saw nothing for all
of it. [ADR-0066](ADR-0066-new-profiles-start-from-a-default-profile.md) promises that uBlock Origin is in place before a
page loads, and the route's promise is that no page loads unrouted. Neither needs the window to wait; both need the page to.

## Alternatives considered

- **Hold the sessions' web requests until the tail ends.** A handler an extension registers during the hold is not in the
  list a request already took, so a blocker loaded after it would be skipped; a service worker's navigation never reaches a
  web-request handler; and Orivon's own start-up fetches (the proxy script's) use the same sessions and would wait for what
  they are needed to finish. The gate is on the making of web tabs instead (`src/main/startup/DESIGN.md`).
- **Show the window after the tail, but make the tail faster** (the unpack in a worker thread, the proxy read bounded
  shorter). It narrows the wait and keeps it: a PAC script on a slow link still holds the window. It is a follow-up that
  shortens the time to the gate, not a way of showing the window sooner.
- **Start the whole tail when the window is shown.** The page's load and paint (about 150 to 200 ms) are idle time for the
  tail, and the gate opens after both. Starting it at creation overlaps them; only the unpacking, which blocks the thread
  that serves the page, still waits for the show.
- **Open the window at creation, on its theme colour, without waiting for its first paint.** Kept as a follow-up if the marks
  show the paint taking more than about 200 ms: the window would appear a frame earlier, empty.
- **A placeholder new-tab page in a window the plan fills, closed after the fill.** The person would see the page flash and
  then jump to the restored one, and closing it is a tab closing, which can close the window. No tab until the gate opens
  looks like a window waiting, which is what it is.

## Reasoning

What the person waits for is a window, and what must not happen early is a page's first request. They are different
moments, so they get different gates: the window waits for its own first paint only, and the page for the route and the
extensions. A single gate that every path to a web page already calls (`deferUntilWebReady`) makes the second cheap to keep,
and a tripwire in `makeTabView` names a path that missed it.

## Consequences

- An address typed into a tab, a bookmark clicked or a second launch's address during the gap waits until the tail has
  ended, and then opens in the order it was asked. The window is responsive in the meantime except where the tail itself
  holds the main process: the synchronous unpack of the bundled extension on a first start. A window that has no tab yet
  (the plan's tabs wait) takes no address in its address bar until its first tab is in.
- What the person gains is the length of the tail, and no more: it is measured at about 65 ms on a warm profile with no
  proxy and 300 to 500 ms on a new profile, against several seconds where the system's proxy settings run a script or a
  disk scans the unpack. Measured on a Linux package under a virtual display (twelve launches of each, four rounds of
  three with the order alternated, on a development machine with other work running), against the start before this
  change (`main` with the paint hold): the window is shown 456 ms earlier on a first start and 12 ms earlier on the next,
  and web pages may load 370 ms later on a first start and 200 ms later on the next, because before this change the tail
  ran ahead of the window and after it the first tab opens once the tail has ended.
- The tail starts at the window's creation, not at its show, so its asynchronous work overlaps the page's load. Against
  the same change with the tail starting at the show, the gate opens 21 ms sooner on a first start and 70 ms sooner on the
  next, and on a next start before the window is shown (94 ms before, where it was 81 ms after); the window itself is shown
  at the same time on a first start and about 45 ms later after its creation on a next start, the cost of the tail
  sharing the main thread with the page's load. On a first start the gate waits for the unpacking, so it opens 377 ms
  after the window is shown (467 ms before).
- A caller that needs the tab a deferred open creates waits for the gate first (`webContentReady()`), as the extension host
  does for `chrome.tabs.create`; `createTab` answers the active tab's id when it defers, which is the wrong tab for such a
  caller.
- A window closed during the gap, on a platform where the browser stays resident (macOS), is not refilled, and the session
  file stays as the previous run left it for the rest of that run: nothing of it was opened, and a window opened
  afterwards is not recorded.
- The first-start marks (`afterWindowDone`, `webContentReady`) now come after `windowShown`, and the start-up line prints
  once the gate has opened.

## Reversibility

- **Cost to reverse:** cheap: `index.ts` runs the tail before `createShellWindow` again and opens the gate at once; every
  other change (the gate, the callers that wait) is correct in either order.
- **What would make us revisit:** a marks record from a screen (not a virtual display) showing the gate opening more than
  about a second after the window was shown on a warm profile with no proxy, which would put the tail's cost back in front
  of the first page it was moved behind the window to hide. Measured here: the gate opens about 90 ms before the window is
  shown on the next start and about 380 ms after it on a first start.
