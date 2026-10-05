# ADR-0058: A page asks the chosen Web3 Score provider through a declared grant

- **Status:** accepted
- **Date:** 2026-10-05
- **Type:** product
- **Decided by:** owner (a declared capability with consent, rather than an ungated call; the
  contracts carry the owner's local `CLAUDE.md` edits); AI recommendation accepted by default (the
  per-origin cache, the rate limit, one address per call)

## Decision
A new capability kind, `trust.score`, declared in a manifest as `"trust": { "score": true }`
(presence only, the shape of `clipboard: { read: true }`), opens one member,
`orivon.trust.websiteScore(address)`. It answers `{ provider, level }`: the name of the Web3
Score provider the person chose in Settings (`web3.scoreProvider`), and the level that provider
judged for the content `address` names, 1 to 4, or `null`. The grant is given like any other, on
visit and under the app's `consentGranularity`; the call checks what was granted, and an ungranted
call rejects `denied`. The contracts live in a new file, `src/contracts/trust.ts`, the eighth.

How the call behaves (build-side behaviour, built in the implementation that follows):

- **A page's lookups share nothing with anyone else's.** One score-provider client per calling
  origin, in a small least-recently-used set of 16, and `.eth` names resolved through the verifier
  in a partition of the caller's own. The shell's own lookups and every other origin's use other
  caches.
- **Rate limited per origin**: a token bucket of 128, refilling 2 a second, on top of the shared
  control limiter. Over it, the call rejects `limit`.
- **Off means nothing is fetched.** With no provider chosen the answer is
  `{ provider: null, level: null }` and no request leaves.
- **One address per call.** No batch member.
- **A lookup that fails answers `level: null`**, never an error.

## Context
Orivon Explore lists sites and marks each Web2, Web2.5 or Web3. It must use the provider the
person chose, not only the snapshot it ships, and has no way to ask: the Web3 Score lookups
(`ADR-0054`) run in the shell, for the page the person is on. The page already calls the member
when it is present and falls back to its snapshot on any rejection, so the gap is the member and
the gate for it.

## Alternatives considered
- **An ungated member, answering every page.** Simplest, and any page could probe the person's
  provider setting and, by timing the shared cache, which sites the person had opened. Rejected:
  `capability-api.md` design rule 5, "No capability is implicit", and the owner chose a declared
  grant.
- **A member only the official apps may call** (a list of origins in the shell). Rejected: it
  gives Explore a power no other app can earn, and the list is a second consent system beside the
  grant ledger.
- **A batch call taking many addresses.** Saves IPC round trips only: a per-caller cache already
  fetches each bucket once, and the provider learns the same bucket pattern either way. Not worth
  a second member to keep stable for apps.
- **One cache shared with the shell.** Faster for the first lookups of a session. Rejected for the
  timing leak above; the cost is that a page's lookup does not benefit from a bucket the shell
  already fetched.
- **Return only the level, not the provider's name.** The name fingerprints which provider the
  person chose. Accepted, because the page holds a grant the person gave, and a page that shows a
  mark should be able to name its source, as the shield does.

## Reasoning
The grant ledger already is the consent system, so a kind in it costs the person nothing new to
learn and costs the contracts one namespace. Keeping each caller's cache apart is what makes the
call safe to offer at all: the sites the shell has looked up are the person's browsing, and a
shared cache would answer a page's question faster for exactly those. The per-origin bucket bounds
what a page can make the provider see, and Explore's own load (about 60 sites) fits it with room.

## Consequences
- `trust.score` is a new member of `src/contracts/manifest.ts`'s `CapabilityKind`; every
  exhaustive switch over it gains a case. The loader, broker, preload and consent halves are an
  implementation that follows this change; until then no manifest can declare it, and the catalogue
  line says `not covered`.
- The provider sees a page's lookups as the same hash-bucket requests the shell sends (`ADR-0054`):
  "this person opened a page that asks about these sites". It cannot tell which app asked. The
  consent label says what is shared.
- A cold `.eth` lookup can take seconds to tens of seconds (a light client), so a page that asks
  about many `.eth` names waits on the verifier's concurrent-mount cap of 4.
- A provider's name is visible to every app holding the grant.
- Adding a member to `src/contracts/` is a change every app feels; this one is additive.

## Reversibility
- **Cost to reverse:** moderate. An app that declared `trust.score` loses the member, and Explore
  falls back to its snapshot by design; no stored data depends on it.
- **What would make us revisit:** a second app needing a different answer shape (the operation and
  connection scales `ADR-0054` can publish), or evidence that a provider can tell apps apart by the
  pattern of their lookups.
