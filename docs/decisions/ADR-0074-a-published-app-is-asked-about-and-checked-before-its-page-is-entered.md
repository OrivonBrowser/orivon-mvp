# ADR-0074: A published app is asked about, downloaded and checked before its page is entered

- **Status:** accepted. Supersedes [`ADR-0012`](ADR-0012-fetch-and-cache-precede-consent.md)'s order for a first visit; amends [`ADR-0018`](ADR-0018-isolation-follows-consent.md) (a first visit's tab stays on the shared session until the files are in) and [`ADR-0029`](ADR-0029-sites-publish-their-bundle-hash-tree.md) (the declared tree now blocks a first install)
- **Date:** 2026-10-08
- **Type:** architecture / security
- **Decided by:** owner (D1 to D5 below); the choices under Consequences are implementation calls, provisional where they say so

## Decision

The first visit to an app Orivon has never held runs in this order:

1. **The person is asked as soon as the manifest is read** (D1), before any of the app's files is downloaded and, for an origin the verifier serves, before any byte of its own page reaches the tab. The tab shows Orivon's setup cover meanwhile.
2. **After Allow, Orivon downloads every file and checks them before the person enters the page** (D2). The cover says so. The files are held in staging; nothing is pinned, registered or served yet.
3. **Files that differ from the app's published declaration** (`/.well-known/orivon-ddoc.json`) are never entered: the files are discarded, **every grant of the origin is removed**, and a security warning names the files that differ. It has no way forward but Go back (D3).
4. **Files that cannot be downloaded** after every gateway was tried again show "Couldn't download <app>" with Try again. The grants are kept and nothing is warned about (D4).
5. **Deny opens the site as a plain website**: not registered, no app tab, no Node globals. The no is remembered, so the site is not asked about again (D5).

Only when the files match, or the site declares nothing to compare them with, are they pinned and registered and the tab sent into the app.

## Context

The Ledger Wallet port crashed on its first `ipns://` visit. The path then fetched, hashed, pinned and registered every file before the question was asked, so a person could be asked about an app that had already been written to their disk, and the app's page (and its deferred scripts) had run unshimmed before the hint that started the install was even reported. `ADR-0012` accepted the first half of that on purpose; the owner has now reversed it for a first install.

## How it is done

- **Verifier-served origins** (`<cid>.ipfs.orivon`, `<key>.ipns.orivon`, `.eth`). A tab's top-level GET to an unregistered, not-refused origin is held in the default session's `onBeforeRequest` (after the verifier's listening gate). Orivon reads the manifest through the verifier, which proves it a file of the content the name leads to; a verified absence means a website, and the request is let go unchanged. For an app the request stays held while the question is open and the files come down. Allow ends in a cancelled request and a navigation through the address bar's own path, so the tab moves to the app's session before its page loads; Deny lets the request go on; a refusal sheet cancels it and stops the pending navigation. No app script runs in the tab at any point before consent and verification. The hold is why the question can precede the page: a navigation the shell never sees (a restored tab, a link, `window.open`, Back) passes the same request.
- **https apps** keep the hint path. The hint is sent on `DOMContentLoaded`, so **the app's HTML, and its scripts up to that point, run before the question**: the tab is stopped and covered when the first stage shows, the manifest is read first so a site that is no app is not disturbed, and everything after is the same flow. Nothing to hold exists before the hint. A page whose first request could not be held (a tab no window knows, a private window's own session) falls back to this path too.
- **The declaration.** `ddocVerdict` compares the computed tree with the declared one: a differing leaf, a file only one side has, or a published root that disagrees with its own leaves each block. **A site that publishes no declaration, or one Orivon cannot read, has nothing to compare: its files are let in on Orivon's own checks (hashes against the manifest's file list, the byte caps, the entry check), which is weaker, and a site that wants the check publishes the tree.**
- **A bundle that is bad for good** (a declared file that answers 404, a script served as a page, a byte cap) is not a download failure, since asking again fetches the same files: it is treated like a mismatch (never entered, grants removed, a warning with the reason, no Try again). A fault that may pass (`transient`: a gateway's 502 or 504, a dropped connection, a manifest that moved while downloading) is the retry sheet.
- **Between the answer and the install** the manifest received must be the one the person was asked about; one that moved gives the retry sheet, and the next attempt asks about whatever is new (grants already held are not asked again).
- **Grants** are made at Allow, before the files come down, which is why D3 removes them and D4 keeps them. They are made against the manifest the person saw. The broker's `registerApp` runs after the install, so the app's floor and saved grants are registered together as before.
- **A block is not remembered.** The next visit starts over and asks again; nothing is recorded that could outlive the publisher fixing the files. A refusal is remembered (the broker's declined-consent record, persisted) and is the one thing that stops the question.

## Alternatives considered

- **An Orivon page as the tab's address** (an interstitial `orivon:` page that redirects to the app). Rejected: the address bar would name the interstitial, not the app, and back/forward would hold it.
- **Cancelling the first request at once and re-navigating after the answer.** Rejected: every first visit would flash a "blocked" page, and a cancelled pending navigation commits an error page for the app's address.
- **Remembering a block.** Rejected for now: a publisher fixing a mis-declared tree would be locked out until the person found a reset, and none exists for this record.
- **Asking only after the download but before the install**, as before. This is what the owner reversed.

## Consequences

- **A site on an origin the verifier serves pays a manifest read before its page loads**, once per root, kept in memory: a verified 404 under the root is remembered. This reads a path no ordinary browser asks for and so is a signal that the visitor runs Orivon; the read goes through the verifier, to the same gateways that serve the page, not to the site.
- **Returning apps, updates ([`ADR-0056`](ADR-0056-an-installed-app-at-a-name-moves-only-when-the-person-accepts.md)), loopback and developer grants and local files are unchanged.** An origin with a saved version floor, a pin or a registration is not a first visit.
- **A refused origin cannot be turned into an app from the page's side**: there is no later `requestGrant` for a website. Reversing a Deny has no control yet (*provisional*; a per-site reset in the site information panel would settle it).
- **A visit that stopped part-way** (the download failed and the person left) holds grants without a pin; it counts as a first visit again, so the next visit resumes without asking again.
- **Several tabs on one origin** ask once: the second waits behind the first and finds the origin known or refused.
- The download's progress is not drawn: the cover shows the stage, not a count.

## Reversibility

- **Cost to reverse:** moderate. The hold, the cover and the sheets are one folder (`src/main/app-setup/`) and the order is one function (`src/main/install/first-visit.ts`); the loader gained two reads that nothing else needs.
- **What would make us revisit:** the hold on a first request breaking a way of reaching a page that has no tab (a prerender, a download); a publisher population that cannot publish a declaration, which would make the unchecked path the common one.
