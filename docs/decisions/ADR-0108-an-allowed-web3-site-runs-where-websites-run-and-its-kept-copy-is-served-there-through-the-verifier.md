# ADR-0108: An allowed web3 site runs where websites run, and its kept copy is served there through the verifier

- **Status:** accepted; amended by [`ADR-0113`](ADR-0113-a-page-an-allowed-sites-own-service-worker-answers-keeps-the-sites-grants-because-no-other-worker-script-can-be-registered-there.md)
  (a page the site's own service worker answers keeps its grants). Amends [`ADR-0007`](ADR-0007-cached-bundles-served-at-their-own-origin.md) (where a kept copy is
  served), [`ADR-0044`](ADR-0044-a-grant-no-longer-gives-an-origin-its-own-session.md) (which origins keep a partition),
  [`ADR-0075`](ADR-0075-a-published-app-is-let-in-when-allowed-and-each-file-is-checked-as-it-is-served.md) (where the
  checked live handler is reached) and
  [`ADR-0076`](ADR-0076-a-first-visit-loads-as-a-website-while-the-app-is-asked-about-and-cached.md) item 3 (the session
  the tab reloads in).
- **Date:** 2026-11-09
- **Type:** architecture
- **Decided by:** owner

## Decision

An allowed app whose host Orivon's protocols serve (a `.eth` name, an IPFS or Swarm address, every host
`BUILTIN_ADDRESSES.routesToVerifier` answers for) runs in the session a website at that origin runs in: the shared
default session. It never gets a partition of its own. Its files still
come from its kept copy, or checked live while the copy is being made: the verifier host hands the requests that are the
site's own to the main process, which answers with the same handler a partition had. A request is the site's own when
the top-level page the shell stamped on it is the site's, or, with no page behind it, when the browser marked it
`Sec-Fetch-Site` `same-origin` or `none`, or when it is a top-level navigation from any site, so a link from another site
opens the kept copy. Another site's page asking for the host keeps the verifier's plain path, whatever its request is
marked: the timing of the answer must not tell a page that an app is kept. A page can change neither the stamp nor the
Fetch Metadata. The person's extensions
run on it as on any other website, one instance with one set of data, and Orivon keeps none of them off it: content scripts,
the toolbar popup, menu entries, shortcuts, the side panel, history and search, network requests and tab capture all
reach an allowed site. What still stands between an extension and the site's grants is ADR-0045: extension code is
refused every `orivon.*` call.

An app on any other origin (a plain `https` host, a loopback address) keeps its own partition, *provisionally*: its
requests never reach the verifier, so nothing outside a partition of its own can serve its kept copy or check its files.
Serving those hosts on the network path too (for example, by sending them to the verifier at start) would settle it.

An allowed web3 site has a website's tunnel session and a website's tunnel identity, with no exception: the owner's rule is
that behaviour is equal and consistent across web3 sites. With a tunnel entry of its own it runs in the profile session of
that entry, apart from the shared one as any website with that entry does, and the copy of each extension in that session
reaches it; with none it follows the browser-wide default and shares the shared identity. A tab's own tunnel choice applies
to it as to a website. The route code (`route-hub.ts`'s `identityOf`, the controller, the leaving-route and tunnel-button
rules) therefore treats an origin that runs as a website as a website, and only an app with a partition of its own as an
app.

The verifier hands a request of a tunnel profile to the shell as it does any other, whether the app is served from its pin
or is still read live: the handler checks every file against the declared tree, and its own reads of the network are made
in that profile's session, whose requests carry the route of its tunnel, so the verifier reads and proves the name
through that tunnel and the read never shows this computer's address. A temporary session opened for a tab's tunnel
choice announces that tunnel too, so the verifier treats its pages' requests as tunnelled and not as direct.

`window.orivon` is attributed to a document of such an app only when three things hold: it runs in the session
`partitionForTab` names (the shared one, or its entry's profile), never in the partition the app had before; the view is
one built as the app's tab; and the shell's own handler answered that very document. The verifier's server puts a mark
on each response it relayed to the shell and on none it gave itself, and takes any such mark out of what the shell sent
and out of what an upstream sent, so no gateway or network page can forge it. The session notes, per page, the mark
of the last main-frame response, and the document's commit takes it once; a commit that no response came for (the HTTP
cache, a worker) takes none. A document the network answered therefore never gets the grants the app holds now: not the
first visit's page, still open in another tab after Allow, and not one the host answered itself in the moment between
the shell serving the app and the host learning it.

## Context

The owner, on extensions doing nothing on an allowed site: "I don't want a copy per app, I want the same data shared
across, that's what extensions are about", and "A Web3site is still a Website, forget 'App', it should keep working
seamlessly as any other web3site." ADR-0044 already chose one extension instance on every page, granted apps included;
ADR-0075 then put every allowed published app in a partition of its own from the first visit, where no extension is
loaded, so the two contradicted each other. The owner also asked that installed apps keep opening at once and offline,
which only the kept copy gives. On the tunnel an allowed site goes through: "Behavior should be equal and consistent
across Web3sites, that's the rule to stick."


## Alternatives considered

- **Load the extensions into each app's partition.** Rejected by the owner: each app would get a separate copy, so a
  wallet or a password manager would start empty in every app.
- **Serve the app on the network path only, as a website.** Loses the kept copy: an installed app would wait for its name
  to be proven at every start, and would not open offline.
- **Answer every `https` request of the shared session in the main process** (`protocol.handle` with a pass-through).
  Every website's every byte would cross the main process, and the cache and cookie behaviour of the pass-through would
  differ from Chromium's own.
- **Keep extensions off allowed sites** (ADR-0044's rejected N3). The owner chose extensions everywhere, again.

## Reasoning

For a host Orivon's protocols serve, every request of every session already reaches the verifier host, so that is the
one place a kept copy can be served from without a partition. The handler that answered in the partition answers here
too, unchanged: the pin, the per-file check of a live-served app, the app's policy headers. The tab can then live in the
session where the extensions are.

## Consequences

- A tab of an allowed web3 site no longer swaps sessions when the site is allowed: the reload after Allow keeps the
  session and changes only the app-tab flag (the Node globals and the routed `fetch`). A navigation that gains the flag is
  stopped before the app's first request and issued again in a view that has it, with the referrer Chromium would have
  sent.
- `window.orivon` attributes a call from such a site to it when the document was answered by the shell's handler, in a
  view built as the app's tab, in the session a website at that origin runs in, never in a partition of its own. What
  the host answers itself, a page of the site that was open before Allow and a document in the window before the host
  knows the app is served alike, has no grants until it loads again.
- The pages of an origin that were open as a website when the shell starts to serve it are loaded again, in every
  session: a website page shares the app's storage and any worker it started, and nothing the shell checked ever ran in
  it. A page that asks "leave this page?" is overruled for that load. A page that is the app's own tab is left alone.
- A block empties and closes the site's pages in every session they are in.
- The extensions' install prompt, the grant prompt and the site-info popover name the extensions that reach an allowed
  web3 site, as they do for any website.
- What such an app stored in its own partition stays there, and a copy is made in the shared session once per origin: the
  app's own cookies (with their attributes; not the cookies of the sites it embedded or called), its local storage, and its
  IndexedDB (each database at its version, with its stores, indexes and records; keys that cannot be exported and
  Blobs included). The copy replaces what the shared session holds for the origin, all or nothing: when the old partition
  holds nothing for the origin, nothing changes; otherwise the session's local storage, databases, service workers and
  Cache Storage for the origin are cleared first, and a copy that cannot finish clears what it wrote. Every moved app is
  copied in the background soon after a start, one at a time, and the app's first page waits for its copy to end, however
  long that takes, up to one deadline per origin (ten minutes, *provisional*); past it the copy stops, clears what it wrote,
  and the page loads. Service workers, Cache Storage and the private file system are not copied, and the app makes them
  again. A cookie, record or database that cannot be copied is named in the log, which a report from `orivon://report`
  carries, and a database with a record missing is marked partial. A copy that failed before any page of the app loaded is
  tried again at later starts, three times at most; one whose failure let a page load is final, since that page may have
  written. A file in the profile records each origin copied or failed, and why.
- The verifier must be running for an allowed web3 site to open, as for every web3 site. A tab of such an app keeps the
  host awake, a request for its host waits until the host listens, and the shell sends the host the hosts it serves
  before any held request is let go, on a start and on a restart alike.
- A request the host relays never touches the shared session's HTTP cache, so bytes a website cached at the same address
  cannot answer the app's request. The service workers and Cache Storage the origin held as a website are removed each
  time the app is served live there, and once at a start for an app served from its pin (one that moved from a partition of
  its own finds them in the shared session), because they would run code nothing checked.
- A website's page that was open when its origin became an app keeps no `window.opener` link to a popup it opens to the
  same origin: the popup opens as a tab of its own, since the page would otherwise script the popup and use its grants,
  and a popup that moves itself to the app's address while its opener is such a page loses the link at the navigation.
- Extensions can block, redirect and record an allowed site, as on any website. A redirect can replace the site's code
  with an extension's while the site holds Orivon permissions; telling safe extensions from unsafe ones is a job for
  Web3 Score providers, later.
- There is no per-app tunnel identity for an allowed web3 site: it has a website's. A person who wants such a site on a
  tunnel of its own gives it an entry, as for any website, and it moves to that entry's profile session with its
  extensions; a site with no entry follows the browser-wide default. Only a plain `https` or loopback app, which keeps a
  partition of its own (provisional, above), has an identity of its own and runs apart from the extensions.
- Clear browsing data keeps the two apart: "Cookies and site data" clears the websites' sessions with an allowed site's
  origin excluded, "App data" clears that origin there. The Cache API cannot be told by origin, so the first empties it
  for every origin of the session; it is a cache the app fills again.
- A child host (`src/main/children/`) of such an app stays on the app's own partition, where the app's handler refuses a
  third party the app holds no grant for; the shared session has no such handler.
- A form POST into the app, and a redirect into it, are not stopped before the app's first request to give the view the
  app-tab flag (a re-issue is a GET and would drop the body, and a redirect's method is not visible); the view is rebuilt
  once the page has committed. Only a navigation the page reported as a plain GET is stopped and re-issued.
- The website workers marker is removed whenever the origin stops being served, and the workers are cleared in every
  session the website ran in (the shared one, the profile of its entry, a profile it has storage in), so a worker a
  website registered between a block and a reinstall never answers for the app. A failure to clear them stops the app
  from being served and says so in its own words.
- The relay rule rests on `Sec-Fetch-*` being visible to the shell's web-request hook with the values the server receives
  (`e2e-website-page-never-becomes-the-app` keeps that measured), so the shell decides on the same headers the host
  does, the stamp included, and bypasses the HTTP cache for exactly what the host relays; a page cached before Allow
  never commits as the app after Back. `treat-as-public-address` stays on a relayed answer: it puts a page of the app in the address space a website at the
  same host is in, which is also the one a page served by a protocol handler (the partition) was in, so reaching a
  loopback or private address differs for neither; the specs of an app reading its own files, its own listener and an
  embedded local page pass with it.

## Reversibility

- **Cost to reverse:** moderate. `partitionForTab` regains its arm for these hosts and the relay stops being fed; data
  stored in the website session meanwhile would not follow back.
- **What would make us revisit:** evidence that a page outside the app could reach the app's grants through the shared
  session, or a reason to serve kept copies without the verifier host. That evidence came once, from a review: a
  live-served app in a tunnel profile was answered by the verifier itself and yet held its grants; a document the network
  answered in the window before the host learned the app was served did too; a website page left open from before Allow
  shared the app's storage; and a temporary tunnel session was taken for a direct one. The Decision and Consequences
  above are the fixes, and the first two close on one rule: a document has grants only if the shell's handler answered it.
