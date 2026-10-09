# ADR-0075: A published app is let in as soon as it is allowed, and each file is checked as it is served

- **Status:** accepted. Supersedes [`ADR-0074`](ADR-0074-a-published-app-is-asked-about-and-checked-before-its-page-is-entered.md)'s D2 to D4 (the download and check before entry, and the retry sheet that download needed); D1 and D5 stand. Amends [`ADR-0018`](ADR-0018-isolation-follows-consent.md) (a consented app's tab is in its own partition from its first entry, served from the verifier until its pin lands) and [`ADR-0029`](ADR-0029-sites-publish-their-bundle-hash-tree.md) (the declared tree is checked per file, as the file arrives). The https limit below is *provisional*.
- **Date:** 2026-10-09
- **Type:** architecture / security
- **Decided by:** owner (the correction below); the choices under How it is done are implementation calls, provisional where they say so

## Decision

The owner, on the merged flow: "With the change you made previously you make load the entire app before opening it. What I asked for was different, I asked, open the app as quick as you can, ask the grants as quick as you can, and if while the pages are loading bad data arrives, the loading of such data is blocked."

A first visit to an app Orivon has never held now runs in this order:

1. **The person is asked as soon as the manifest is read** (ADR-0074 D1, unchanged), and the app's declared tree (`/.well-known/orivon-ddoc.json`) is read in parallel with the question, so it is ready when the person answers.
2. **Allow grants at once and the tab enters the app at once** (app tab, Node globals, its own isolation). The app's files are loaded on demand, like any site's.
3. **Every file the page loads is checked as it is served** against the leaf the declared tree gives it (`leaves: { "/path": "sha256:..." }`, the loader's own leaf function, so the leaves are those `orivon-port hash` prints). A file is delivered only after its leaf matches. A mismatch is bad data: that response is never delivered, the tab is stopped and covered by the security warning (no way forward), every grant of the origin is removed and the app is forgotten. A bad first document is never seen.
4. **The whole bundle is downloaded and pinned in the background**, after entry. A later visit is served from the pin. A background download that fails is silent and finished on the next visit; one that fails an integrity check (a file differing from the declared tree, or content the verifier proves is not what its address names) is bad data, the same block, even though the page loaded fine.
5. **An app that publishes no declared tree** (a 4xx, or a body that is no tree) is let in on Orivon's own checks alone: the manifest's file list, the byte caps, the entry check. That is weaker, and a site that wants the per-file check publishes its tree.
6. **Unchanged:** the first navigation is held until the question is answered (verifier-served origins), Deny opens a plain website and only a pressed Deny is remembered, Escape and timeouts record nothing, Settings "Ask again", the gateway retries, revocation on a block, and the hint path for `https` (blank before asking).

## How it is done

- **Where the check runs.** Origins the verifier serves (`<cid>.ipfs.orivon`, `<key>.ipns.orivon`, `.eth`) are served by Orivon's own loopback server, which already holds each file's bytes. A request that names the leaf it expects (`x-orivon-expect-leaf`) gets its file only after the server buffered that one file, verified it against its address as it always does, and hashed it to that leaf under the request's canonical path; on a mismatch it answers `502` with `x-orivon-failure: ddoc-mismatch` and no byte of the file. A range is cut from the buffered file after the check. The wait for buffer room is bounded, since a page opens many files at once.
- **The expected leaf comes with the request, not from state in the verifier.** The leaf table lives in the shell, beside the registration that makes the origin an app; the server keeps nothing to replay when the host restarts or sleeps. Every request names the root the manifest was read from, so a name that moved fails rather than mixing two releases.
- **The consented app has a partition before it has a pin.** A tab's partition is fixed when its view is built and an origin's partition needs a handler for its scheme (ADR-0007), so the app is registered with a handler that answers from the verifier (`src/loader/serve/live-serve.ts`) and the tab enters its own partition at once. That handler resolves a request against the files the manifest lists, as the pinned handler does, applies the same CSP, isolation headers and third-party reach gate, and fetches the file from the verifier naming its leaf. `registerServingFor` replaces it in place when the pin lands. `isOriginServedFromCacheSync` keeps its name and now means "has a handler of its own partition"; `isOriginPinnedSync` says it answers from the pin, and is what the trust indicator and the verifier's idle test read.
- **What is bad data and what is only denied.** A listed file the declared tree has no leaf for, a leaf that differs, and the manifest itself differing from its leaf, are bad data. A path the manifest does not list is answered `404` and is not: a page can reach what a pinned app could and nothing more, and a probe for an unlisted path must not block an app. *Provisional.*
- **The block** is one function (`src/main/install/first-visit.ts`, `letIn`), raised once however many files fail: every tab of the origin and the tab the visit let in are stopped, emptied and covered (`src/main/app-setup/block-tabs.ts`), `Broker.forgetOrigin` revokes every grant and deletes the registration and version floor, the origin's handler and partition storage are removed, and the background download is stopped. The next visit is a first visit and asks again; a block is not remembered.
- **The tree cannot be read** (a 5xx, a timeout, a dropped connection) is the one wait left after Allow: a "Couldn't check" sheet with Try again, nothing granted, the answer kept. It is no permission to skip the check.
- **The background download holds the origin's queue** and the origin reads as `settling`, so a page's own manifest hint does not start a second install beside it. It begins three seconds after entry so the first page has the connection to itself.
- **https apps cannot be checked per response** in the default session (the files come from the site's own host, through Chromium's network stack). They enter at once and the bundle is verified in the background; bad data then blocks within seconds or minutes, not before the first byte. *Provisional;* a protocol handler for the app's own session would settle it, and is the same shape as the verifier handler above.

## Alternatives considered

- **Download and check the whole bundle before entering** (ADR-0074 D2). Rejected by the owner: the person waits for the app before it opens.
- **Push each origin's leaf table into the verifier host.** Rejected: it is state that dies with the host's restarts and sleeps and must be replayed, for no check the request header does not already make.
- **Enter in the shared session until the pin lands.** Rejected: whatever the app stores in its first minutes would be left behind when the tab moves to its own partition.
- **Let the page load straight from the verifier in a partition with no handler.** Rejected: no reach gate and no CSP for the app's requests.
- **Block only the file and let the page run on.** Rejected: bad data arrives from a publisher whose other files are then suspect, and the owner's answer is that the origin loses every grant.

## Consequences

- Between Allow and the pin, every file of an app a verifier serves passes through the shell and the loopback server once more than a pinned app's would. A failed background download leaves the app registered and granted with no pin; the next visit goes through the ordinary install.
- An https app's first minutes run in the shared session; its storage moves to the app's partition at its first navigation after the pin. This is the cost of the provisional limit above.
- The verifier host stays awake while an app served from it has a tab, as a site does.

## Reversibility

- **Cost to reverse:** moderate. The check is one request header and one function in the loopback server; the live handler is one file the pin's handler replaces; the order is one function.
- **What would make us revisit:** apps whose files are large enough that buffering one to check it is felt (the cap is 64 MiB), or a measured gap between the live handler's responses and a pinned app's.
