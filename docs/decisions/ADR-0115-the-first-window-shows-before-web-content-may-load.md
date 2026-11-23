# ADR-0115: The first window shows before web content may load

- **Status:** accepted
- **Date:** 2026-11-20
- **Type:** architecture
- **Decided by:** owner for the goal (the browser on screen about a second after the click, on every start); AI recommendation for the order

## Decision

The first window is created and shown as soon as the registrations (`afterReady`) and the shell's stores exist. The slow
tail of every subsystem (`afterWindow`: the route's first read of the system's proxy settings, loading the person's
extensions, installing the bundled extensions into a new profile) starts with the boot, right after `afterReady`, and is not
awaited there: it runs beside the making of the stores, the shell's services and the window, and while the window loads and
paints its page ([`window-first.ts`](../../src/main/startup/window-first.ts)). When the tail has ended without a critical
failure, it opens the gate on web pages (`openWebContent()` in [`web-ready.ts`](../../src/main/startup/web-ready.ts)); then
the first window is filled (the restored session, the addresses on the command line, What's new, the other windows of a
session), the session file is released, and only then is a second launch answered. A critical failure of the tail shows the
error dialog and ends the process; the gate never opens.

Until the gate opens the window shows the new-tab page (or the page a private session opens on), or no tab when the plan
fills the window, and no tab, navigation or wake of a sleeping tab loads a page of the web: what asks waits and runs, in the
order it asked, when the gate opens. The shell's own pages never wait. While the plan's tabs are not yet open the session
file is held, so a start that ends early keeps the previous session.

## Context

Every start created its first window only after the whole tail had ended: the system proxy read (up to seconds on a PAC
script), and on a new profile a synchronous unpack of uBlock Origin's 781 files (1.7 to 3.5 s; the package now carries it
unpacked, so a new profile pays only the install of a folder). A person saw nothing for all of it. [ADR-0066](ADR-0066-new-profiles-start-from-a-default-profile.md) promises that uBlock Origin is in place before a
page loads, and the route's promise is that no page loads unrouted. Neither needs the window to wait; both need the page to.

## Alternatives considered

- **Hold the sessions' web requests until the tail ends.** A handler an extension registers during the hold is not in the
  list a request already took, so a blocker loaded after it would be skipped; a service worker's navigation never reaches a
  web-request handler; and Orivon's own start-up fetches (the proxy script's) use the same sessions and would wait for what
  they are needed to finish. The gate is on the making of web tabs instead (`src/main/startup/DESIGN.md`).
- **Show the window after the tail, but make the tail faster** (the unpack in a worker thread, the proxy read bounded
  shorter). It narrows the wait and keeps it: a PAC script on a slow link still holds the window. It is a follow-up that
  shortens the time to the gate, not a way of showing the window sooner.
- **Start the tail when the window is created, or when it is shown.** Both are later than the boot reaching it, and the
  tail's first steps are asynchronous reads that the window's own making does not need to wait behind: started with the boot
  the tail overlaps the stores' load, the window's making, its page's load and its paint, and the gate opens sooner than
  after either.
- **Hold the tail's one synchronous step (the unpacking of the bundled extension) until the window is shown.** It was needed
  while the package carried the extension packed: the step held the main thread, which serves the window's page. The
  package carries it unpacked now, so nothing in the tail holds the thread for long and the wait is gone.
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
  ended, and then opens in the order it was asked. The window is responsive in the meantime. A window that has no tab yet
  (the plan's tabs wait) takes no address in its address bar until its first tab is in.
- What the person gains is the length of the tail, and no more: on a warm profile with no proxy it is about 40 ms of the
  main thread, more where the system's proxy settings run a script. Measured on a Linux package under a virtual display
  (twelve launches of each, four rounds of three with the order alternated, on a development machine with other work
  running; medians, in ms from the process start), against `main` and against the same change with the tail starting at the
  window's creation. First start: the window is shown at 870 (870 with the tail at the creation, 1134 on `main`) and web
  pages may load at 642 (805; 652). Next start: the window is shown at 856 (717; 790) and web pages may load at 538 (616;
  468). From the end of `afterReady`, the point where the three differ in code, the next start's window is shown after 380
  ms (284; 376) and its gate opens after 78 ms (190; 40).
- The two ends trade against each other, because the main thread does the same work in every order: the tail's own work
  (loading the extensions, about 40 to 70 ms on a next start) runs before the window's creation when the tail starts with
  the boot, and after it, in the time the window spends waiting for its page, when the tail starts at the creation. Starting
  with the boot gives the earliest gate (38 ms after `main`'s on a next start on Linux, about 110 ms on Windows) and no
  earlier window than `main`'s on a next start; starting at the creation gives the earliest window (96 ms before this one
  on a next start) and a gate 112 ms later. On a first start the window is shown at the same time either way (870 and 870) and
  the gate opens 163 ms sooner when the tail starts with the boot. On Windows (six launches each, two runners, from
  `afterReady`): first start window 948 (929; 1330), gate 722 (1035; 608); next start window 314 (271; 334), gate 184 (238;
  71).
- A caller that needs the tab a deferred open creates waits for the gate first (`webContentReady()`), as the extension host
  does for `chrome.tabs.create`; `createTab` answers the active tab's id when it defers, which is the wrong tab for such a
  caller.
- A window closed during the gap, on a platform where the browser stays resident (macOS), is not refilled, and the session
  file stays as the previous run left it for the rest of that run: nothing of it was opened, and a window opened
  afterwards is not recorded.
- The marks `afterWindowDone` and `webContentReady` can come before `firstWindowCreated` and `windowShown` (on a next start
  they usually do), and the start-up line prints once the gate has opened.

## Reversibility

- **Cost to reverse:** cheap: `index.ts` starts the tail once the first window is created instead of with the boot, or
  awaits it before `createShellWindow` and opens the gate at once; every other change (the gate, the callers that wait) is
  correct in any of the three orders.
- **What would make us revisit:** a marks record from a screen (not a virtual display) showing the gate opening more than
  about a second after `afterReady` ended on a warm profile with no proxy, which would put the tail's cost back in front of
  the first page it was moved behind the window to hide; or a start-up goal that prefers the next start's window to its gate
  by more than the 100 ms the measurements put between them (starting the tail at the window's creation).
