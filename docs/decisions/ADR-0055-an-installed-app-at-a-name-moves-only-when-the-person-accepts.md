# ADR-0055: An installed app at a name moves to new content only when the person accepts; a judged level counts only at the domain its manifest names

- **Status:** accepted
- **Date:** 2026-10-05
- **Type:** security
- **Decided by:** AI recommendation accepted by default (the open questions on the plan stand on
  their defaults until the owner answers)
- **Amends:** ADR-0005 (no silent update at a name), ADR-0012 (only the manifest is fetched before
  asking), ADR-0030 (an installed name stops following its contenthash), ADR-0054 (a judged level
  picks a path, and counts only where it is bound)

## Decision
An installed app reached at a name (ENS, DNSLink, IPNS) keeps running the version it was installed
at until the person accepts a newer one. Orivon notices a moved name when the person visits it
(at most every 5 minutes) and, while an app tab is open, every 30 minutes; it fetches only the new
manifest, and the bundle only after the person says yes. An update is **verified** when the chosen
Web3 Score provider has an evaluation for exactly the new CID (any level), the pinned CID's
evaluation, if it has one, is not higher, the new version is above the version floor, the new
manifest's `domain` equals the origin's host, and the pointers verify. A verified update asks
"Do you want to switch to the new version?" with Yes and Not now. Any other update is a notice
with a reason and no Yes; the key icon offers **Trust & Force update**, which confirms and lists
the grants and data it hands over. Grants and data carry over: the origin is the same.

`Manifest.domain` names the one ENS name or DNS host an app calls home. A judged level counts
only at the host its manifest names. A mismatched or missing `domain` makes the app unverified,
never refused. A manifest identical to the pinned one whose bundle hash is also equal moves the
pin with no prompt.

## Context
Ported apps opened at their content address, so a new build was a new origin with no grants or
data; at a name, Orivon found a new bundle only through a hint on a page visit, downloaded it
before asking, never re-checked an open tab, and never reloaded after an accepted update.
A judged level was attached to a CID wherever it was served, so a validated app under another
name would show the level of the original (`open-questions.md` A236, the `.eth` half).

## Alternatives considered
- **Download the bundle first, check hourly.** What the loader did. The download lets any name
  owner spend bandwidth and disk before a person can refuse; the manifest alone is enough to ask.
- **Verified means Level 3 or higher.** Rejected: the first provider judges FreeTube Level 2, so
  the bar would fail the owner's own example. An evaluation for the exact CID, no lower than the
  pinned one's, is the claim a provider can make today. *Provisional*: it means evaluated, not safe,
  until the Security score has levels.
- **Refuse a mismatched `domain`.** Rejected: it breaks every mirror and every gateway copy of an
  app. Unverified keeps the app running and withholds the borrowed level.
- **A domain in the provider's file format.** Rejected: the manifest is a leaf of the CID, so a
  judgement of the CID already covers its `domain`, and the provider format stays as it is.
- **A list of domains.** Rejected: one home per app keeps the comparison a string match and the
  consent line one sentence.

## Reasoning
The version a person runs is the pin on their own profile, so a name that moves can never change
running code by itself, and the first visit stays trust on first use. A judged level is a claim
about a CID; the manifest inside the CID says where that content lives, so the claim counts at
that name and at no other. Checking at most every 5 minutes on a visit, and every 30 minutes for an
open tab, finds a move within the time a person would notice, and the name cache already lags 2
minutes.

## Consequences
- An app published without `domain` shows its observed Level 2, not the judged level, until it is
  republished with one. Ports gain a `domain` and a `<upstream>.<build>` version.
- With the provider setting cleared every update is a notice (case 1); a profile that never chose
  reads the official provider (`d-0484`). With DNSLink or the light client off every update is
  unverified.
- Trust & Force hands over grants and data guarded only by its confirmation.
- A service worker's update fetch may bypass the cache-served partition; the boundary end-to-end
  spec settles it and `security-model.md` T81 names the result.
- A manifest-less website can still lend its judged level to another name.

## Reversibility
- **Cost to reverse:** moderate. `domain` is a public manifest field once ports publish it; the
  rest is shell behaviour.
- **What would make us revisit:** the Security score gaining levels (a stricter verified rule), or
  a provider format that signs a domain.
