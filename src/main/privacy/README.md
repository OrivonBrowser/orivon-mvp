# `src/main/privacy/`: forgetting what the browser kept

**What lives here.** `clear-data.ts` does "Clear browsing data": history back as far as chosen, the
cookies and storage of ordinary websites, the cache, the saved zoom levels, and (only when asked for by
name) the browser storage of every app that holds permissions. `privacy-domain.ts` is what the Settings page
may ask: how much is kept, and to clear.

**What it depends on.** `electron` (types: the sessions cleared);
[`../history/`](../history/) and [`../zoom/`](../zoom/) (what is forgotten through them);
[`../pages/internal-ipc.ts`](../pages/internal-ipc.ts) (the shape of a page's domain).

**What it must never import.** [`../shell/`](../shell/).

**Owner stream.** `shell`.

**Electron dependence.** `clear-data.ts` receives its sessions as arguments and is testable without Electron;
which sessions there are is decided by [`../pages/start-internal-pages.ts`](../pages/start-internal-pages.ts).

## Design notes

**A time range applies to history only.** Electron clears a session's data by type and origin, with no time range,
so site data and the cache are all or nothing, and the page says so.

**An app's storage is a separate choice.** An app keeps working data (a signed-in session, a local database) in
its own session, so clearing "cookies and site data" never reaches it. Choosing App data clears the browser
storage of every app that holds permissions; the files an app saved in its own folder, its permissions and its
installed code are not touched.

**One part failing does not stop the others.** The result names what could not be cleared.
