# ADR-0066: A new profile starts from a default profile

- **Status:** accepted
- **Date:** 2026-10-07
- **Type:** product
- **Decided by:** **owner**

## Decision
A new profile of Orivon starts with:

1. **Five bookmarks in the bar**, in this order, each with an icon: Uniswap, James Carnley, ENS Interviews,
   Web3 Compass, Vitalik Buterin.
2. **uBlock Origin**, the full one, installed and pinned to the toolbar.
3. **The Web3 Score provider** `ipfs://attila.orivonstack.eth/score`.
4. **The Extensions button always shown.**
5. **"Orivon Featured" on the new tab** (Explore, The Lounge, FreeTube, ASGARDEX, Element), drawn with the tile
   the bookmarks use; the Torrent and Nostr tiles are gone.

Items 3 and 4 are schema defaults (`src/main/settings/schema.ts`). Items 1 and 2 are seeds, and they apply
to a profile Orivon has never run on: when the browser starts, none of `history.db`, `bookmarks.json` and
`extensions/registry.json` exists in its folder (`settings.json` does not count). That is decided once, before any
store opens a file. A person who removes a bookmark, empties the bar or removes uBlock Origin is never given them
back, and an existing profile keeps what it has, even one with no bookmarks or no extensions. A private window installs no extension and has the bookmarks.
`ORIVON_DEFAULT_PROFILE=off` skips both seeds; the end-to-end harness sets it, `npm run dev` leaves it on.

uBlock Origin is fetched, not committed: `resources/default-profile/bundled-extensions.json` pins a release asset
and its sha256, `scripts/fetch-bundled-extensions.mjs` downloads it into a folder git ignores, and every
`package:*` script runs it with `--required`. It installs through the ordinary extension installer with no prompt
and with the pin recorded before the load.

Telemetry is unchanged: the welcome screen asks, and an unanswered question sends nothing.

## Context
A first run showed an empty bar, no ad blocker and a provider-less shield, so the first impression of the browser
depended on what the person went on to install. The owner asked for a profile that is useful at the first start.
The full uBlock Origin works through `webRequest` (ADR-0053), which is what makes it worth shipping.

## Alternatives considered
- **Commit the `.crx` to the repository.** 4.5 MB of someone else's binary in history on every update, and no
  record of where it came from. The pinned url and digest say both.
- **Download uBlock Origin at the first start.** The first start would depend on the network, and a download that
  fails is silent for the person. A package that fetched at build time has it on every machine.
- **Seed on every start while the item is missing.** Removing a bookmark or uBlock Origin would be undone, and a
  person would learn that a choice does not stick.
- **Seed only the new tab and leave the bar empty.** The tiles of the new tab are not a place a person keeps
  their own sites.

## Reasoning
"No file is a first launch" is the convention the bookmark store already used, and the registry is written by the
first install and never removed, so the same test works for both. The two settings are defaults rather than
seeds so a later change to them reaches everyone who never chose, as the provider already does.

## Consequences
- Every profile that never chose a provider or an Extensions-button mode moves to the new default, not only new
  profiles.
- uBlock Origin fetches its own filter lists from the first start; `docs/privacy/outbound-requests.md` row 14a
  lists it, and it can be removed.
- A bookmark's address is kept in the form its page is served from, so `ipfs://vitalik.eth` is stored as
  `https://vitalik.eth/` (the same origin the tab has).
- uBlock Origin's id is the one its release key signs to (`fkgkibajhfbepljeaefdnfnegdcjomkh`), not the Chrome Web
  Store's.
- A newer bundled uBlock Origin does **not** update a profile that already has it. *Provisional*: an update path
  for bundled extensions settles it.
- The packaging machine needs the network once per `package:*` run, or the file already fetched.

## Reversibility
- **Cost to reverse:** cheap for the lists and defaults; a profile that was seeded keeps what it was given.
- **What would make us revisit:** a bundled extension that needs updating on profiles that already have it; a
  second bundled extension; a pinned release asset that disappears.
