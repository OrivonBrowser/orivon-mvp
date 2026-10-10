# ADR-0076: A first visit loads as an ordinary website while the app is asked about and cached, and the tab reloads as the app when it is allowed

- **Status:** accepted. Supersedes [`ADR-0075`](ADR-0075-a-published-app-is-let-in-when-allowed-and-each-file-is-checked-as-it-is-served.md)'s item 7 (the first navigation held until the question is answered, and the hint path's blank page before asking) and the part of [`ADR-0074`](ADR-0074-a-published-app-is-asked-about-and-checked-before-its-page-is-entered.md) D1 that kept every file and every script back until the answer. The rest of ADR-0075 stands: the per-file check after Allow, the durable allowed-not-pinned state, new versions under the widening rule, the block.
- **Date:** 2026-10-10
- **Type:** architecture / user experience
- **Decided by:** owner (the correction below)

## Decision

The owner, on the merged flow: "Yeah but now the app does not load at all until you decide on permissions, it should keep loading and caching anyway, only that it does without Orivon grants, until the user accepts, and the page is reloaded this time with Orivon permissions."

A first visit to an app Orivon has never held now runs in this order:

1. **The page loads at once, as an ordinary website.** Nothing is held. The first navigation goes through the default session like any website's: no grants, no app tab, no Node globals, no cover over it.
2. **Beside that, Orivon reads the manifest and asks as soon as it is read** (unchanged), and **at the same moment starts caching**: it reads the declared tree, downloads every file with the per-file leaf check, and stages the bundle. Nothing is pinned, registered or granted before the answer.
3. **Allow** registers and grants as before and **reloads the tab as the app** (app tab, its own partition, the Node globals), served by the checked live handler, or from the pin when the staged bundle has landed and was pinned first. The page the person sees after Allow is the app, with its grants held from its first line.
4. **Deny** leaves the page as the website it already is, stops the caching and discards what was staged; nothing is pinned. A pressed Deny is remembered; Escape and a timeout record nothing (unchanged).
5. **Bad data found while caching** (a file that is not the declared one, content the verifier proves is not what its address names, a manifest its own tree contradicts) before the answer **stops the page**: the tab is emptied and shows the security warning, the question is withdrawn, and nothing is pinned. Nothing was granted, so there is nothing to take away. After Allow the same finding is the block of ADR-0075: every grant, the registration and the version floor go, the storage stays.
6. **While the question is open nothing of the page is held**: it reloads and follows its own links as any website does, and the question stays; it is withdrawn only when the tab leaves the origin or the app is stopped. Escape or a timeout records nothing and means not now for the rest of the run: no question on a reload, a link or the page's own hint in any tab, and the staged cache is kept. A second visit from a tab that is already being asked is dropped. The answer buttons are guarded alike, so a stray key cannot persist a refusal.
7. **Letting the app in and a block are serialised per origin.** The serving, registration, grants and the record that survives a restart are one step; a block that lands during it stops the pages at once and takes the origin away when the step has ended, which undoes all of it, and the tab is not sent in.
8. **A caching failure that is not bad data** (a gateway that is unwell, a connection that dropped) before the answer is silent: the page is already showing, and the files are fetched again once the person allows it, with the "Couldn't check" sheet and Try again only for a tree that cannot be read after Allow.

## How it is done

- The default-session `onBeforeRequest` handler (`src/main/app-setup/first-visit-hook.ts`) notices the first request of a tab to an origin Orivon has never held and starts the visit beside it, returning the request unchanged. The page's own manifest hint (`src/main/install/manifest-hint.ts`), which is the only way in for an `https` app, starts the same visit; both enter and leave a tab through `src/main/app-setup/tab-host.ts`.
- The cover and the sheet appear only when a block or a retry needs the sheet; the page is never covered while it loads or while the question is open.
- Caching is `createKeeper(...).cache()` in `src/main/install/first-visit-keeper.ts`; Allow reuses what it staged (`run`), pins first when caching has finished, and otherwise serves live and pins when the download ends. A test seam delays the start of caching (`ORIVON_TEST_BACKGROUND_PIN_DELAY_MS`).
- A block before the answer cancels the question through the asking caller's `signal`, so the warning has the tab's panel to itself.

## Alternatives considered

- **Hold the first navigation until the answer** (ADR-0075 item 7). Rejected by the owner: the app does not load at all while the person decides.
- **Cache only after Allow.** Rejected: the person waits on the whole download after answering, which the owner's order removes.
- **Run the first load as an app tab with its grants pending.** Rejected: a call answered `denied` and a state written before the answer would be the app's own, and a tab's partition is fixed when its view is built.
- **Pin before the answer.** Rejected: a pin is an installed app; it follows the answer.

## Consequences

- A page that is an app runs once as a website before it is allowed: its scripts run in the default session with no grants, and anything it stores there stays in that session and is not carried into the app's own partition. An app that has a sign-in or setup step in its first page shows it twice.
- Pre-answer caching spends bandwidth on an app the person may then deny; it stops at once on Deny and discards what it staged.
- The app's files are fetched once for the page and once for the cache before the answer; an app served from the pin after Allow needs no further fetch.
- The cross-origin reach of the plain page is that of any website; nothing Orivon grants applies to it.

## Reversibility

- **Cost to reverse:** low to moderate. The hook and the hint path call one host; holding the first navigation again is a change in `first-visit-hook.ts` and the pre-answer caching in `first-visit.ts`.
- **What would make us revisit:** an app whose plain first load does damage that a held page would not (a page that acts on its own on load against another service), measured bandwidth waste from denied apps.
