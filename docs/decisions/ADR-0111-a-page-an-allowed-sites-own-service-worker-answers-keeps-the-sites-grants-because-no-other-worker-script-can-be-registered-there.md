# ADR-0111: A page an allowed site's own service worker answers keeps the site's grants, because no worker script the shell did not serve can be registered there

- **Status:** accepted. Amends [`ADR-0108`](ADR-0108-an-allowed-web3-site-runs-where-websites-run-and-its-kept-copy-is-served-there-through-the-verifier.md)
  (which document of such a site holds the app's grants).
- **Date:** 2026-11-10
- **Type:** security
- **Decided by:** AI recommendation accepted by default

## Decision

A document of an allowed web3 site that runs where websites run (`runsAsWebsite`) is the app's when the shell's own handler
answered it (ADR-0108), or when the site's own service worker did. The worker's answer is the app's own when all of these hold:

1. The shell served the origin where websites run when the document committed, and the view is the app's tab, in the session
   `partitionForTab` names.
2. No response of any kind was seen for the document: not the shell's, not the network's, not the HTTP cache's. A worker's
   answer reaches no web-request hook.
3. The tab's top frame reported, as the document began, that a service worker controls it. The report is the preload's read of
   `navigator.serviceWorker.controller` in its isolated world, and main takes it only from the tab's top frame, for the address
   the document committed at, and forgets it when the next navigation starts.
4. The worker is the app's. From the moment the shell prepares to serve the origin until it stops, a worker script of that
   origin (or a script it imports: `importScripts` and the static imports of a module worker both reach the hook as a `script`
   request with no page behind it, measured in Electron 44) that the shell did not serve is cancelled when its headers arrive, in every website session:
   its response carries no `x-orivon-shell-answered` mark. The guard is armed before the workers a website left are removed
   (`website-workers.ts`), so no worker can be registered between the removal and the serving, and every worker that exists at
   the origin got its scripts from the shell's handler, which checks each file against the declared tree. The same preparer
   runs for the pinned apps the loader restores at a start, because it is registered before the loader is.

Everything else stays denied: a document read from the HTTP cache, a document the network answered (whatever controls it), a
document for which nothing is known (no response and no controller), a document that committed before the shell served the
origin, a view that is not the app's tab, and a document outside the session a website at the origin runs in.

## Context

ADR-0108 attributes `window.orivon` to a document only if the shell's handler answered that very document, read from the mark
on its main-frame response. A navigation the app's own service worker answers never reaches a web-request hook, so no mark is
seen, and an offline-first app lost its grants on every reload once its worker was installed. The premise that a commit with no
response is the cache's or a worker's, and so not the app's, was right for a worker a website left and wrong for the app's own.

## Alternatives considered

- **Attribute every document a worker answers.** A worker whose script the network gave (registered by a website's page in the
  moment the host has not yet learned the app is served) could answer with any HTML and the grants of its document.
- **Note, per script address, whether the shell answered it, and check the controller's script address at attribution.**
  Electron names no controller for a document and a script address names no version: a waiting version the network gave beside
  an active one the shell gave at one address looks the same as two honest ones. The note does not survive a restart while the
  registrations do, so the first page after every start would be denied, which is the failure being fixed.
- **Unregister the origin's workers when a script the shell did not serve is seen.** Heals, but only after the worker exists, and
  needs a record that survives a crash between seeing and removing; the guard needs neither.
- **Track registrations from `session.serviceWorkers`.** It reports a scope and a version, not which document a version controls,
  and no script address of a stopped worker.

## Reasoning

Two facts decide the rule, and a page can change neither.

*Which workers exist.* The mark is written by the verifier's server on what the shell answered, and it takes any such header out
of what the shell sent and out of what an upstream sent. The hook that reads it runs in the main process. A page, a worker or a
gateway has no way to set it, or to keep the hook from running. Refusing the unmarked script at registration makes "every
worker at this origin was served by the shell" a property of the session's storage, which holds across restarts and for every
version of a registration, with no record to keep in step.

*That a worker controls this document.* Only the renderer knows. The preload reads it in its isolated world: the page's world
has its own wrappers and prototypes and cannot change what the platform reports there, and it has no handle on the preload's
`ipcRenderer`. Main takes the report only from the tab's top frame and for the committed address, so a subframe or a
message about another document is ignored. If the report were absent or false, the document is denied, as it was.

A page of the app can register a worker, and that goes through the shell's check. A document of the origin can also write
Cache Storage, which a worker may answer from, and nothing checks what it writes. The documents that could are the ones the
shell did not answer, and while the origin is served the only such documents are the website pages that were open when the
serving began: the shell loads them again as it starts to serve (`stale-pages.ts`). In the span between the removal of the
website's caches and that load, such a page could leave an entry that the app's worker later answers with. What it could
leave is what the verifier served for that name, which is the content the declaration describes, and the grants it reaches
are those of the app the person accepted. Removing the caches again once those pages are gone would also remove the app's
own precache, so this stays a limit of the rule (*provisional*: closing the old pages before the removal would settle it).

## Consequences

- An offline-first allowed site keeps `window.orivon` on every page its worker answers, on a reload, on a start and with the
  gateway gone.
- A website page at the origin that registers a worker while the host does not yet know the site is served (the page open
  before Allow, or loaded in that moment) has its worker script refused: its registration fails with a network error, and the
  log says `[verifier] refused a service worker script the shell did not serve`. The page it came from is a website's, and was
  never the app's.
- The guard works on `script` loads with no page behind them, so a dedicated or shared worker's script at such an origin in
  that same moment is refused too. A page the app owns is unaffected: all its requests are the shell's.
- The report is one IPC message per document that a worker controls, and nothing for any other. Electron 44 builds a new
  document for a history navigation (it has no back-forward cache), so Back to a page the worker answered reports again.
- A worker registered by a build without this guard is not re-checked. A person who wants one gone blocks the site and allows it
  again, which removes the origin's workers when it is next served.
- An origin the shell serves in a partition of its own (a plain `https` host, a loopback address) is unchanged: its documents
  are answered by its own handler, which sees a worker's answers too.

## Reversibility

- **Cost to reverse:** cheap. Remove the guard and the report, and a worker-answered document is denied again.
- **What would make us revisit:** a request that reaches the shell's handler through a worker without the mark (the relay not
  marking an answer it gave), or an Electron API that names a document's controller in the main process, which would replace
  the preload's report.
