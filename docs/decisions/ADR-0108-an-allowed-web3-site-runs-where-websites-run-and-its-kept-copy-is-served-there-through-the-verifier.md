# ADR-0108: An allowed web3 site runs where websites run, and its kept copy is served there through the verifier

- **Status:** accepted. Amends [`ADR-0007`](ADR-0007-cached-bundles-served-at-their-own-origin.md) (where a kept copy is
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
come from its kept copy, or checked live while the copy is being made: the verifier host hands every request for a host
the shell serves to the main process, which answers with the same handler a partition had. The person's extensions
run on it as on any other website, one instance with one set of data, and Orivon keeps none of them off it: content scripts,
the toolbar popup, menu entries, shortcuts, the side panel, history and search, network requests and tab capture all
reach an allowed site. What still stands between an extension and the site's grants is ADR-0045: extension code is
refused every `orivon.*` call.

An app on any other origin (a plain `https` host, a loopback address) keeps its own partition, *provisionally*: its
requests never reach the verifier, so nothing outside a partition of its own can serve its kept copy or check its files.
Serving those hosts on the network path too (for example, by sending them to the verifier at start) would settle it.
So does an app with a route of its own, a tunnel entry or an entry that is off while the browser is on a tunnel: the
verifier does not hand a tunnel profile's requests to the shell (the host fetches for them only through that tunnel), and
the app's own reads leave by its own route, so the shared session cannot send the app as its own route would. It keeps
its partition until the shared session and the app's route agree, or until a tunnel profile's requests reach the shell
too. A tab's own tunnel choice does not apply to an installed app, as before.

`window.orivon` is attributed to a document of such an app in the session `partitionForTab` names, the shared one, and
never in the partition the app had before. The document must also have committed after the shell began to serve the
app: one that committed before (the first visit's page, still open in another tab after Allow) came from the network,
and the grants the app holds now do not reach it until it loads again.

## Context

The owner, on extensions doing nothing on an allowed site: "I don't want a copy per app, I want the same data shared
across, that's what extensions are about", and "A Web3site is still a Website, forget 'App', it should keep working
seamlessly as any other web3site." ADR-0044 already chose one extension instance on every page, granted apps included;
ADR-0075 then put every allowed published app in a partition of its own from the first visit, where no extension is
loaded, so the two contradicted each other. The owner also asked that installed apps keep opening at once and offline,
which only the kept copy gives.

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
  session and changes only the app-tab flag (the Node globals and the routed `fetch`).
- `window.orivon` attributes a call from such a site to it when the page runs in the shared session and committed after
  the shell began to serve the app, never in a partition of its own.
- A block empties and closes the site's pages in every session they are in.
- The extensions' install prompt, the grant prompt and the site-info popover name the extensions that reach an allowed
  web3 site, as they do for any website.
- What such an app stored in its own partition before this change stays there. A later step carries it into the shared
  session once, the first time the app opens there: cookies, local storage and databases are carried, and what cannot be
  is named in the log. Until then an app that moved starts with empty storage.
- The verifier must be running for an allowed web3 site to open, as for every web3 site. If the host restarts, the shell
  sends it the hosts it serves again before it answers.
- Extensions can block, redirect and record an allowed site, as on any website. A redirect can replace the site's code
  with an extension's while the site holds Orivon permissions; telling safe extensions from unsafe ones is a job for
  Web3 Score providers, later.
- A plain `https` or loopback app, and an app with a route of its own, still run apart from the extensions (provisional,
  above).

## Reversibility

- **Cost to reverse:** moderate. `partitionForTab` regains its arm for these hosts and the relay stops being fed; data
  stored in the website session meanwhile would not follow back.
- **What would make us revisit:** evidence that a page outside the app could reach the app's grants through the shared
  session, or a reason to serve kept copies without the verifier host.
