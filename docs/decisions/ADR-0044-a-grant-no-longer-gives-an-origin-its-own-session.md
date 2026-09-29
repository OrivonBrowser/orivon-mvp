# ADR-0044: A grant no longer gives an origin its own session; a pinned cache still does

- **Status:** accepted
- **Date:** 2026-09-29
- **Type:** architecture
- **Decided by:** owner

## Decision

An origin's tab runs in its own Electron partition, `persist:app-<sha256>`, only while the origin
is served from the pinned cache. An origin that holds grants and is delivered from the network
runs in the default session, with every other website. This amends ADR-0018, which gave a
partition to an origin holding at least one live grant.

In the default session Orivon owns each `webRequest` event through one listener
(`src/main/sessions/web-request-owner.ts`) that runs its handlers in a fixed order. The granted
origin's CSP (T22), with the cross-origin isolation headers its manifest asks for, is appended by
that session's last `onHeadersReceived` handler to every response from an origin that holds a
grant; the verifier's partition stamp is the last `onBeforeSendHeaders` handler.

## Context

The owner wants Chrome extensions to act on every page, including the apps a person has granted
permissions to, as one instance: one login, one set of settings. Electron loads an extension
into one session at a time and keeps its service worker and storage per session, so one instance
means one session. With a partition per granted origin, a password manager would need a separate
login in every Web3 app.

## Alternatives considered

- **Load every extension into every app partition.** A separate instance per app: split
  logins, memory growing with apps times extensions, and an extension with network permissions in
  a partition that serves `https` through `protocol.handle` sends the page's requests to the
  network instead of the pin (measured, `docs/planning/spike-results/extension-network-probe.json`).
- **No extensions on granted apps** (the exploration's N3). The only design in which the Orivon
  permission is a wall; the owner chose extensions everywhere.
- **Move cache-served origins into the default session too.** `protocol.handle('https')` takes
  the whole scheme for a session, and ADR-0007's fail-closed pin needs a session that holds one
  origin. Serving pins on the network path first is its own piece of work.

## Reasoning

Storage stays separated per origin by the same-origin policy, as in every browser; what the
partition added was a second wall between a granted origin and every other site in one person's
browsing, and a place to hang the per-app CSP listener. The CSP moves to the shared session's one
owner of `onHeadersReceived`, keyed by the response's origin. The pinned cache keeps its
partition because its guarantee depends on it.

## Consequences

- A granted, network-served app shares cookies and cache with the rest of the default session.
  Cookies it sets with a `Domain` attribute reach its sibling hosts: every `<cid>.ipfs.orivon` is
  one site to Chromium, since `ipfs.orivon` is not a public suffix.
- Data a granted app stored in its `persist:app-*` partition is not moved; the app starts with
  empty storage in the default session once.
- A navigation between two granted, network-served origins no longer swaps the tab's view, so
  back and forward keep working across them. Entering or leaving a cache-served origin still
  swaps it (T18).
- Nothing in Orivon registers a `webRequest` listener on the default session except through the
  owner; a direct registration would silently replace the owner's.
- Extensions run on granted apps. What stops their code using the app's grants is ADR-0045.

## Reversibility

- **Cost to reverse:** moderate. `partitionForTarget` regains its grant arm and the CSP returns
  to per-partition listeners; data stored meanwhile in the default session would not follow.
- **What would make us revisit:** evidence that a granted app's storage needs isolation beyond
  the same-origin policy, or the extension-instance requirement being dropped.
