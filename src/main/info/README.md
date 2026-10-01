# `src/main/info/`: the About page and the task manager

**What lives here.** The two diagnostic pages and what they ask of main. `about-info.ts` turns the facts
of this build (versions, system, paths) and the graphics report into the rows the About page shows, and
`about-domain.ts` answers the page's three requests (the version table, the graphics report, and to copy
either); `about-runner.ts` reads the facts from the running process and writes the clipboard.
`tasks-model.ts` joins the process metrics Electron reports with what main knows each process is showing,
names the rows, and decides which may be ended; `tasks-domain.ts` answers the page's three requests (the
list, to end a process, to go to a tab); `tasks-runner.ts` gathers the metrics and the pages of every
window, signals a process, and activates a tab.

**Tied to Electron, in the runners.** `about-runner.ts` and `tasks-runner.ts` import `electron`; the
rest is pure and runs under plain vitest.

**What it depends on.** `electron`; [`../pages/`](../pages/) (the domain type and the page ids);
[`../shell/`](../shell/) (the window registry and the app-tab set, read-only); [`../settings/`](../settings/)
(the downloads folder shown in the table).

**What it must never import.** [`../../renderer/`](../../renderer/), and anything in `../shell/` that
would let it change a window other than activating a tab.

**Owner stream.** `shell`.

## Design notes

**A process is ended by a number main looks up again.** The task manager page sends a process id, and
`endProcess` rebuilds the list from a fresh `app.getAppMetrics()` and acts only when that id is in it and
its row is endable. Only a row of tabs and apps is endable: the browser, the graphics process, the network
and other utility processes, an extension, and any process that also hosts one of Orivon's own views (the
window, an overlay, an internal page) are never offered, since ending them would take the window or the
browser's network with them.

**The process is ended through a page that main found in it.** `endProcess` calls `forcefullyCrashRenderer()` on
the page the fresh reading matched to that id, and never signals a bare number, so a process id the system has
since given to something else is never touched. The tab gets the same `render-process-gone` report and the
same crashed state as any crash.

**The first processor reading is shown as unknown.** Electron measures CPU since the previous call, so the
first call reads 0 for every process. A reading more than ten seconds after the last counts as a first one.

**Aliases are the address bar's alone.** `../pages/internal-aliases.ts` is called from the one place a person
types an address; a link, a popup or an external open that names `about:` or `chrome://` is refused as
before.

**The Console panel is asked for until it is selected.** `../devtools/open-console.ts` repeats the request
because the frontend ignores a panel named before it has built its own views.
