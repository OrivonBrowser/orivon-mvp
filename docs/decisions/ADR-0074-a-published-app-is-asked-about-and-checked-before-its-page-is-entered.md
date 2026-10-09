# ADR-0074: A published app is asked about, downloaded and checked before its page is entered

- **Status:** accepted. Supersedes [`ADR-0012`](ADR-0012-fetch-and-cache-precede-consent.md)'s order for a first visit; amends [`ADR-0018`](ADR-0018-isolation-follows-consent.md) (a first visit's tab stays on the shared session until the files are in) and [`ADR-0029`](ADR-0029-sites-publish-their-bundle-hash-tree.md) (the declared tree now blocks a first install)
- **Date:** 2026-10-08
- **Type:** architecture / security
- **Decided by:** owner (D1 to D5 below); the choices under Consequences are implementation calls, provisional where they say so

## Decision

The first visit to an app Orivon has never held runs in this order:

1. **The person is asked as soon as the manifest is read** (D1), before any of the app's files is downloaded and, for an origin the verifier serves, before any byte of its own page reaches the tab. The tab shows Orivon's setup cover meanwhile.
2. **After Allow, Orivon downloads every file and checks them before the person enters the page** (D2). The cover says so. The files are held in staging; nothing is pinned, registered, served or **granted** yet: the answer waits as a pending consent, and is applied together with the pin and the registration once the files are let in.
3. **Files that differ from the app's published declaration** (`/.well-known/orivon-ddoc.json`), and files the verifier proved are not what their address names, are never entered: they are discarded, the pending consent is dropped, any grant of the origin an earlier version of Orivon left is revoked, and a security warning names the files. It has no way forward but Go back (D3).
4. **Every other failure to get the files** (a timeout, a refusing status, a dropped connection, a declaration that could not be downloaded, a manifest that moved meanwhile) shows "Couldn't download <app>" with Try again (D4). The pending consent is kept while the sheet is up, nothing is warned about, and Try again does not ask again unless the manifest now asks for more. An app larger than Orivon allows gets its own plain message, with no warning and no Try again.
5. **Deny opens the site as a plain website**: not registered, no app tab, no Node globals (D5). Only the pressed Deny button is a no, and it is remembered for the site; Escape, a timeout, a closed tab or a navigation away record nothing and the next visit asks again. Settings, Sites lists a refused app with Ask again, which takes the record away.

Only when the files match, or the site declares nothing to compare them with, are they pinned and registered, the answer granted, and the tab sent into the app.

## Context

The Ledger Wallet port crashed on its first `ipns://` visit. The path then fetched, hashed, pinned and registered every file before the question was asked, so a person could be asked about an app that had already been written to their disk, and the app's page (and its deferred scripts) had run unshimmed before the hint that started the install was even reported. `ADR-0012` accepted the first half of that on purpose; the owner has now reversed it for a first install.

## How it is done

- **Which navigations are held.** A tab's top-level GET, in the **default session only**, to an unregistered, not-refused origin the verifier serves (`<cid>.ipfs.orivon`, `<key>.ipns.orivon`, `.eth`) is held in `onBeforeRequest` (after the verifier's listening gate). Orivon reads the manifest through the verifier, which proves it a file of the content the name leads to; a verified absence means a website, and the request is let go unchanged. The first look is bounded (10 s): a page whose manifest has not been read by then loads as an ordinary page, and its manifest hint, if it has one, starts the hint path below. For an app the request stays held while the question is open and the files come down. Allow ends in a cancelled request and a navigation through the address bar's own path, so the tab moves to the app's session before its page loads; Deny lets the request go on; a refusal sheet cancels it and stops the pending navigation. A navigation the shell never sees (a restored tab, a link, `window.open`, Back) passes the same request. During the wait the loading screen of the protocol covers the tab after 300 ms, so no wait is blank. **A link or a pop-up from an app's own partition to an app origin Orivon has never held is not held**: that partition is another session, which has no hold, and its first page runs there until its hint is reported, so it takes the hint path.
- **The hint path** (an `https` app, whose HTML runs until `DOMContentLoaded` before a hint exists; the fallback above; a page whose first request could not be held). Once the manifest reads as an app, the first stage replaces the running page in place with an empty one (`stop()` does not stop script), so the network copy does not run beside the question; the tab then goes through the same order. Entering, and opening the site as a plain website, navigate the tab to the address the hint came from through the address bar's own path. Contents that no window holds as a tab use the same order with no screens: a question, no sheets, and a reload to enter.
- **The declaration.** `ddocVerdict` compares the computed tree with the declared one: a differing leaf, a file only one side has, or a published root that disagrees with its own leaves each block. It is fetched before any file, with the same retries, and one that cannot be downloaded (anything but a 404) is a failed download, never "not published". **A site that publishes no declaration, a 404, or a body that is no declaration, has nothing to compare: its files are let in on Orivon's own checks (hashes against the manifest's file list, the byte caps, the entry check), which is weaker, and a site that wants the check publishes the tree.** An `https` site whose files differ is looked at once more before the warning, since a deploy may have landed while they came down; content a name or address proved cannot change under its root and is not.
- **What blocks.** Only a real integrity failure: a declaration mismatch, and a verifier answer that says the content failed verification (`x-orivon-failure: unverifiable`, set by the verifier on that and nothing else). A gateway outage reads as `unavailable` and is a failed download.
- **Between the answer and the install** the manifest received must be the one the person was asked about; one that moved gives the retry sheet, and the next attempt asks about whatever is new.
- **The tab is never acted on after the person left it.** The visit follows the tab: another navigation or its destruction ends the screens, aborts the download and frees the origin's queue, and every navigation, stop and entry first checks the tab is still where the visit began.
- **A block is not remembered.** The next visit starts over and asks again; nothing is recorded that could outlive the publisher fixing the files.

## Alternatives considered

- **An Orivon page as the tab's address** (an interstitial `orivon:` page that redirects to the app). Rejected: the address bar would name the interstitial, not the app, and back/forward would hold it.
- **Cancelling the first request at once and re-navigating after the answer.** Rejected: every first visit would flash a "blocked" page, and a cancelled pending navigation commits an error page for the app's address.
- **Remembering a block.** Rejected: a publisher fixing a mis-declared tree would be locked out until the person found a reset.
- **Granting at Allow and revoking on a mismatch** (the first build). Rejected: an unchecked `https` page keeps running beside the question, and its grants would be live; granting only after the files are checked leaves nothing to take back.
- **Asking only after the download but before the install**, as before. This is what the owner reversed.

## Consequences

- **A site on an origin the verifier serves pays a manifest read before its page loads**, once per root, kept in memory: a verified 404 under the root is remembered. This reads a path no ordinary browser asks for and so is a signal that the visitor runs Orivon; the read goes through the verifier, to the same gateways that serve the page, not to the site.
- **Returning apps, updates ([`ADR-0056`](ADR-0056-an-installed-app-at-a-name-moves-only-when-the-person-accepts.md)), loopback and developer grants and local files are unchanged.** An origin with a saved version floor, a pin or a registration is not a first visit.
- **A refused origin cannot be turned into an app from the page's side**: there is no later `requestGrant` for a website. The person reverses a Deny in Settings, Sites (*Apps you refused*, Ask again). The record is `declined-apps.json` in the profile, and memory only in a private window.
- **A visit that stopped before the files were let in** granted nothing and recorded nothing, so the next visit asks again; the answer waits only while the retry sheet is up.
- **Several tabs on one origin** ask once: the second waits behind the first and finds the origin known or refused.
- The download's progress is not drawn: the cover shows the stage, not a count.

## Reversibility

- **Cost to reverse:** moderate. The hold, the cover and the sheets are one folder (`src/main/app-setup/`) and the order is one function (`src/main/install/first-visit.ts`); the loader gained two reads and two options of `fetchBundle` that nothing else needs.
- **What would make us revisit:** the hold on a first request breaking a way of reaching a page that has no tab (a prerender, a download); a publisher population that cannot publish a declaration, which would make the unchecked path the common one.
