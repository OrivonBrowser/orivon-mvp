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
system's settings and the loading of the extensions can take a good part of a second, and a window needs neither: its pages
are the shell's own, served by Orivon.
[`window-first.ts`](window-first.ts) is the order: the boot starts the tail (`startTail`) the moment `afterReady` has ended,
where it always ran, and does not await it; the shell's services, its stores and the first window are made while it runs; the
tail ends by opening the gate (a critical failure of it ends the start with the error dialog and the gate never opens); and
`endStart` fills the first window once both the tail and the window exist, and only then answers a second launch, so it
never meets a window with no tabs or opens a second one. The gate therefore opens when the tail ends, not when the boot
reaches the window, and on a next start that can be before the window is made.

**`startTail` never rejects.** The end of the start awaits the tail some hundreds of milliseconds after the boot makes it, so
a rejection in between would be unhandled, and the process ends on one (`start.ts`). A throw no subsystem caught is therefore
a critical failure of the start, said and ended like one, and the promise settles with `stopped: true`.

**Why the tail may run beside the boot.** `runAfterWindow` runs the route and then the extensions, one after the other
(`runSerial`), and it yields only at an `await`. Nothing between `startTail` and the first `await` of the boot (the stores'
load) yields, so `createShellServices`, `attachExtensionShell` and the publishers all run before any step of the tail resumes:
the extensions are loaded after the shell is attached, exactly as when the tail ran after the window, and the extension host
accepts either order anyway (`whenShellServices` waits for a shell not yet attached, every other reach is `bridge?.`).
`ctx.routes.followSettings` runs after the stores load, so it can land before, between or after the steps of the route's first
pass. It is safe in each place: the route service starts from the settings file read before the store existed, so it applies
only a difference between that file and the store (none, unless the file changed within the start), through the events a later
change by the person fires and the controller already settles; the relay's switch and the Secure DNS choice likewise start
from the file; and the controller adopts every session when it is made (stopped at once while the whole browser is on the
tunnel, otherwise followed to the system's setting the mirror's set reaches), as it did for a session made after the gate.
Before this order the tail ended before `followSettings` (a difference was applied after the gate had opened) or began after
it; the order now only interleaves those two cases.

**What waits for the end of the start, and why those.** A step that runs before `createShellWindow` delays the window directly, and
on Windows a few calls of the system cost tens of milliseconds each on the main thread. Measured on a hosted runner: the jump list's
`setUserTasks` 55 ms on every start and 98 ms on a first one, the history file's checkpoint after the retention prune 48 ms and the
`fsync` of the orphaned-partition cleanup's marker 58 ms, both on a first start. [`after-start.ts`](after-start.ts) holds the
tasks that need none of the window: the launcher entries (`../os/install-launcher-menu.ts` keeps only the process's id before the
window, which the taskbar groups by), the retention prune and the orphaned-partition cleanup. Each was read for an order it needs:

- The system keeps the jump list it was last given, and the dock menu is read at a click on the icon, so neither is needed before
  the window.
- The prune only forgets what is past the retention the person chose. The History page and the Settings count follow it through
  `history.changed`, and a start that ends within the delay prunes at the next one.
- The cleanup touches only partitions no app uses (an origin with a grant and no app on disk). It asks
  `isOriginServedFromCacheSync` what serving was restored this run: after the tail has ended that is the settled answer, where at the
  boot it raced the tail and leaned on the pin and folder checks beside it. An app installed between the cleanup's check and its
  `clearData` is as exposed as before, now with the person at the browser, but only a profile that has not yet run the cleanup and
  already holds grants has an app to lose: the marker is written once, and a new profile has no grants.

The cookie mirror stays before the window: it decides the cookies of the tunnel profiles for the first page that loads, so it is
installed before the gate opens (`../route/cookie-mirror/`).

**The delay is three seconds, from the end of the start.** The first tab finishes loading 0.2 to 0.5 s after the window shows on the
Windows starts measured, so three seconds is past it with room, and short enough that the jump list and the retention are in place
before a person looks for either. A longer wait would only lengthen the specs that wait for the prune. The tasks run one to a turn
of the event loop, so a key or a message that arrived during one is served before the next. The timer is unreferenced: a process
that ends first never runs them, and the next start does.

A window the plan fills has no tab until the gate opens: a placeholder new-tab page would flash and then be closed, which is a
tab closing and can close the window.
