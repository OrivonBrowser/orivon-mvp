# `src/main/devtools/`: developer tools for the pages a tab shows

**What lives here.** `devtools-service.ts` decides whether developer tools may open on a page and
opens them, for every way in: the key, the main menu, and "Inspect" in a page's own menu.
`devtools-prompt.ts` is the one question asked before they open on an app that holds permissions.

**What it depends on.** `electron` (the prompt, and the `WebContents` it acts on);
[`../settings/`](../settings/) (whether developer tools are allowed, and where they open).
The rest arrives as functions: which app a page runs as and which pages are the shell's own is decided by
the caller (`../shell/shell-services.ts`).

**What it must never import.** [`../shell/`](../shell/) as values, and [`../pages/`](../pages/): the
shell hands this directory what it needs to know about a tab.

**Owner stream.** `shell`.

**Electron dependence.** Tied to it: DevTools is Chromium's, and this directory only decides when to open it.

## Design notes

**Developer tools are a setting, not developer mode.** Developer mode (`../dev/`) is the set of
overrides that make a local origin count as an app, set from outside the browser and never from a
page. Developer tools are on for every tab by default and a person can turn them off in Settings; they
do not widen what any origin may do.

**A console on an app acts with the app's permissions.** Someone pasting into it what a stranger
told them to paste hands that stranger the app's grants. The first opening for each app in a run asks
once, with Cancel as the default answer. Chromium's own warning about pasting into the console stays. A page
is an app by the session it runs in, not by its address alone: a popup an app opened is at `about:blank`,
holds the app's opener, and is asked about as that app.

**The shell's own pages are closed to them** outside developer mode: their console would hold the
channel Settings speaks on.

**They close when the page they belong to stops being the tab's.** A tab that moves to another origin's
session has a different view; tools left open on the old one would inspect a blank page.
