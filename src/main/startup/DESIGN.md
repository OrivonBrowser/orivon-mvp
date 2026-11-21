# `src/main/startup/`: why it has this shape

Read only when changing a decision here; [`README.md`](README.md) is the map.

**[`web-ready.ts`](web-ready.ts) gates the making of web tabs and navigations, not requests.** A hold on the sessions'
web requests cannot promise that a page loads routed and blocked. A handler registered during the hold is not in the
list a request already took, so a content blocker loaded after it would be skipped; a service worker's navigation never
reaches a web-request handler; and Orivon's own start-up fetches (the proxy script's) go through the same sessions and
would wait for what they are needed to finish. A view made before the default session holds its extensions would also
carry a copy of none. So every path from an address to a web page, [`../shell/tab-open.ts`](../shell/tab-open.ts) and
`navigateTab` first, calls `deferUntilWebReady`, and `makeTabView` in [`../shell/tab-view.ts`](../shell/tab-view.ts)
logs a tripwire line for a web view made while the gate is shut, which names a path the list missed.

**A caller that needs the opened tab's id waits before it opens, not inside the opener.** `createTab` answers the
active tab's id when it defers, as it does at the tab limit, so a restored tab's pin, title and history would go to the
wrong tab. The reopen key and the restore bar wait first for that reason; any new caller of `openSnapshot` must too.

**The window waits for its own first paint and nothing else; the pages wait for the tail.** The route's first read of the
system's settings and the loading of the extensions (on a new profile, unpacking the bundled one synchronously) can take
seconds, and a window needs neither: its pages are the shell's own, served by Orivon.
[`window-first.ts`](window-first.ts) is the order: the window shows, `afterWindow` runs, the gate opens, the first window is
filled, and a second launch is answered last, so it never meets a window with no tabs or opens a second one. A critical
failure of the tail ends the start with the error dialog and the gate never opens. A window the plan fills has no tab until the
gate opens: a placeholder new-tab page would flash and then be closed, which is a tab closing and can close the window.
