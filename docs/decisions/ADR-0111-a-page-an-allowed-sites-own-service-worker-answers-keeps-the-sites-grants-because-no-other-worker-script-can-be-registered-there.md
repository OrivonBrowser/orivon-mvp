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
   runs for the pinned apps the loader restores at a start, because it is registered before the loader is. A request that
   another origin issued (a worker of another site importing a script from this origin, when Electron names the initiator)
   registers nothing here and is let go.
5. The origin has settled, and the document committed after it did (below).

Everything else stays denied: a document read from the HTTP cache, a document the network answered (whatever controls it), a
document for which nothing is known (no response and no controller), a document that committed before the shell served the
origin or before the origin settled, a view that is not the app's tab, and a document outside the session a website at the
origin runs in.

### Settling an origin

A document of the origin that the shell did not answer can write Cache Storage, and the app's worker may answer from it with
bytes the declared tree never checked. Such documents are the website's pages: the ones open before Allow, a first visit's own
tab, and any page the host answered from the network in the span before it was told the shell serves the origin. They may
run a version the name's owner has moved to, which must not reach the app's worker without the person accepting it. So once the
shell serves such an origin, it settles in this order, and until step 4 no document's worker-answered state counts:

1. The shell announces what it serves to the verifier host, and waits until the host says it applied that announcement
   (`shell-serves-applied`). From then on every page the host loads for the origin is the shell's. When no host runs, the
   announcement counts as applied: the host takes the set from its configuration when it starts.
2. Every website page of the origin open at that moment, in every session the origin runs in, is loaded again, and the wait ends
   when each new document has committed. A document the shell answered and the hidden page of the storage carry are left alone.
   The tab a first visit is sending in is not loaded again: the visit loads it as the app once the host has said it was told (it
   waits for that, within a bound), and the settling waits for the tab to show the shell's document.
3. When a page showing a website's document was seen at the origin at any time since the serving began (open when it began,
   open when the host was heard, or the tab a first visit sent in, whether or not it has closed since), the origin's service
   workers and Cache Storage are removed in every session a website at the origin ran in. What those documents wrote is gone, and
   the pages that remain are the shell's.
4. The origin is marked settled. A document counts only if it committed after step 3 (a clock shared by commits and settlings
   keeps the order), so a document the removal did not precede never counts, however long it lives. When no website page was
   open, the serving's own start is the line.

A worker script the shell served is held until the origin has settled (the guard of rule 4 answers it then), so the registration
it starts comes after the removal in step 3 and cannot be wiped by it; the app's first page registers its worker as soon as the
origin settles. A script of an origin that cannot settle is cancelled, as an unmarked one is.

Each wait is bounded: 10 s for the host's word (the first visit's too), 15 s for each page to load again, 10 s for the first
visit's tab to show the shell's document and 15 s for the removal (*provisional*: field reports of a slow host would settle the
numbers). A bound that runs out leaves the origin unsettled, so a document its worker answers has no grants and the worker
scripts of the origin are cancelled, and the settling is tried again after 3 s, then 6 s and so on to a minute, for as long as
the shell serves the origin. A first visit loads its tab as the app when the host has said it was told or the bound ran out,
without waiting for the removal: the app's first page is the shell's, and the pages its worker answers wait for the settling.

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
- **Load the website's pages again and remove their caches in the same pass that announces the serving.** A page loaded or
  opened in the span before the host is told is answered by the network, is never loaded again, and can write Cache Storage for
  as long as it stays open; the order above waits for the host first, and the removal for the pages' new documents.
- **Track registrations from `session.serviceWorkers`.** It reports a scope and a version, not which document a version controls,
  and no script address of a stopped worker.

## Reasoning

Two facts decide the rule, and a page can change neither.

*Which workers exist.* The mark is written by the verifier's server on what the shell answered, and it takes any such header out
of what the shell sent and out of what an upstream sent. The hook that reads it runs in the main process. A page, a worker or a
gateway has no way to set it, or to keep the hook from running. An extension can rewrite response headers, so the same two
places refuse it: the extension dispatch and the declarative rules ignore any attempt to add, change or remove a header that
begins `x-orivon-`, on a request or a response, and the watch reads the mark where the network's headers arrive, before an
extension's change. Refusing the unmarked script at registration makes "every worker at this origin was served by the shell" a
property of the session's storage, which holds across restarts and for every version of a registration, with no record to keep
in step.

*That a worker controls this document.* Only the renderer knows. The preload reads it in its isolated world: the page's world
has its own wrappers and prototypes and cannot change what the platform reports there, and it has no handle on the preload's
`ipcRenderer`. Main takes the report only from the tab's top frame and for the committed address, so a subframe or a
message about another document is ignored. If the report were absent or false, the document is denied, as it was.

A page of the app can register a worker, and that goes through the shell's check. A document of the origin can also write
Cache Storage, which a worker may answer from, and nothing checks what it writes. The settling closes that for every page
that is open: the host is known to answer as the shell before the website's pages load again, so the page that loads again
(or opens afterwards) is the shell's, and what the earlier documents wrote is removed once they are gone and before any
worker's answer counts. Removing the caches before the pages were gone would let a page write again, and doing it while the
host still answered from the network would let the new document be one the network gave. The order is the fix.

What it does not reach: a page opened and closed wholly between two looks of the settling (it looks when the serving begins and
again when the host has been heard) is never seen, so what it wrote to Cache Storage is not removed when no other website page
was seen (*provisional*: noting each website document that commits while an origin is unsettled, in every view, would close it).

## Consequences

- An offline-first allowed site keeps `window.orivon` on every page its worker answers once the origin has settled, on a
  reload, on a start and with the gateway gone.
- While an origin is unsettled, a document its worker answers has no grants, and the worker scripts of the origin wait (a
  registration of the app's own worker starts when the origin settles). At a start the settling has nothing to wait for but the
  host's word, which an unstarted host counts as given, so it ends at once; a slow or hung host makes the worker's answers
  wait, never the shell's own.
- A website page at the origin that registers a worker while the host does not yet know the site is served (the page open
  before Allow, or loaded in that moment) has its worker script refused: its registration fails with a network error, and the
  log says `[verifier] refused a service worker script the shell did not serve`. The page it came from is a website's, and was
  never the app's, and is loaded again once the host knows.
- The guard works on `script` loads with no page behind them, so a dedicated or shared worker's script at such an origin in
  that same moment is refused too. A page the app owns is unaffected: all its requests are the shell's. A worker of another
  site that imports a script from the origin is not, when Electron names the initiator.
- The report is one IPC message per document that a worker controls, and nothing for any other. Electron 44 builds a new
  document for a history navigation (it has no back-forward cache), so Back to a page the worker answered reports again.
- The marks that say an origin's website workers were removed live in a directory named for this rule (`website-workers-cleared-v2`).
  A mark of an earlier rule is not read, so a pinned app whose workers were let in without the guard has its origin cleared once
  more, with the guard armed, the next time it is served.
- **A content script of an extension can still get the app's worker to serve a page the shell never checked.** A content script
  runs in the app tab's origin and can write Cache Storage for it (`caches.put` of a page with an inline script); the app's own
  worker may answer a navigation from that entry, and the document runs without the shell's content-security policy and holds
  `window.orivon`. This is the class of risk ADR-0108 already accepts for an extension on an allowed site (an extension can block,
  redirect and record it, and it can read the page), widened in reach: a webRequest permission is no longer needed, any extension
  with host access to the site does. Telling a safe extension from another is a job for the Web3 Score providers, not for this
  rule. The settling removes what website pages wrote, so no website page remains as an attacker; this one is the person's own
  extension.
- An origin the shell serves in a partition of its own (a plain `https` host, a loopback address) is unchanged: its documents
  are answered by its own handler, which sees a worker's answers too.

## Reversibility

- **Cost to reverse:** cheap. Remove the guard and the report, and a worker-answered document is denied again.
- **What would make us revisit:** a request that reaches the shell's handler through a worker without the mark (the relay not
  marking an answer it gave), or an Electron API that names a document's controller in the main process, which would replace
  the preload's report.
