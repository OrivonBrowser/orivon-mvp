# ADR-0004: First-run explicit choice, self-hosted, inspectable telemetry

- **Status:** accepted; first-run explicit choice (2026-08-25). **Superseded in part by
  [ADR-0063](ADR-0063-telemetry-v2.md)**: its payload, install identifier and country field. The
  choice, self-hosting, inspectability and the silent response channel stand
- **Date:** 2026-08-18
- **Type:** product / security
- **Decided by:** **owner** (values decision); payload, delivery and disclosure per AI recommendation

> **Earlier versions.** An opt-in version came first, then the owner chose measurement
> efficiency over opt-in. The choice that stands is neither: an explicit answer on first run, with
> nothing preselected. The AI concern about default-on stays stated under "Residual risk".

## Decision
Orivon ships usage telemetry that is **self-hosted**, **minimal**, **inspectable in the
product**, and enabled through a **first-run explicit choice**: the disclosure shows the
literal payload and offers two answers with no preselected default (ADR-0063 gives the answer its
form: two equal buttons on the welcome screen and a switch in Settings). Nothing is sent before the
user chooses. No third-party analytics service is used,
ever.

*(Why explicit: the metric targets EU users, and an install identifier is an "online
identifier" under GDPR, so pure opt-out sat in gray territory a privacy-branded browser cannot
afford. An explicit choice is defensible as consent and keeps more data than opt-in.)*

**The payload of this ADR** (the payload in force is ADR-0063's, with ADR-0064's country; this one shows what the three
changes below remove and keep):
```jsonc
{
  "installId": "…",      // random UUID generated locally at first run.
                         // NOT derived from hardware, MAC, hostname or any device property.
  "country":   "IT",     // SELF-DECLARED on the first-run screen. The endpoint needs
                         // nothing from the IP, so no unverifiable promise is required.
  "version":   "0.1.0",
  "period":    "2026-09",              // monthly aggregate, NOT a session timeline
  "perApp": {
    "torrent": { "activeSec": 90000,   // focused + interacting, within an idle timeout
                 "backgroundSec": 412000 }   // running, idle, seeding
  }
}
```

**Three changes, each reducing what is collected:**

1. **`activeSec` is split from `backgroundSec`, and the metric is stated on `activeSec`**
   (owner decision). The previous `durationSec` measured how long the app was *open*, and a
   torrent client seeds in the background by design, so the active-use threshold was satisfiable by a user
   who pasted one magnet and walked away. The metric could not distinguish a daily driver from
   an idle process, making the central hypothesis unfalsifiable in its own favour.
2. **Monthly aggregate replaces the session array.** Per-session `startedAt` against a stable
   ID, over months, is a daily activity pattern (waking hours, working hours, real timezone),
   materially more identifying than `country`, and unnecessary: the metric needs a sum, not a
   timeline. Send once per period at a randomised offset; do not queue-and-retry into a backlog
   that reconstructs the timeline just removed.
3. **`country` is self-declared.** (ADR-0063 replaces it with a region from the time zone.) It was the only reason the endpoint touched the IP at all,
   and "the IP is discarded at ingest" was the single claim in the whole design that a user
   could not verify locally, since TLS terminates somewhere that sees the IP regardless. Asking
   directly removes the unverifiable promise instead of asserting it harder.

**Also required:** the client **ignores the response body entirely**: no server-driven config,
no kill switch, no remote command channel. Otherwise the only server Orivon runs is one
compromise away from controlling every install. And session accounting must checkpoint
periodically, so a crash loses minutes rather than a whole session.

**Never collected:** URLs, magnet links, infohashes, search queries, peer addresses, file
names, Nostr pubkeys, IP addresses (beyond momentary use at ingest), or any device
fingerprint. (ADR-0063 adds one device-derived identifier, a keyed one-way hash of the machine
ID, read only after consent.)

## Context
The success metric (its numbers are kept privately) counts active users over a month. That
cannot be validated without per-user monthly usage data, so *some* stable identifier and
*some* duration measurement are unavoidable. The privacy-minded people Orivon
serves are the most telemetry-hostile population on the internet and will actively look for this.

Owner's position: anonymised, non-invasive data (country and usage) is acceptable, and
measurement efficiency matters more than the opt-in ceremony.

## Alternatives considered
- **Opt-in (previously accepted, now rejected by the owner).** Converts 30-60%, which would
  have required several times more installs to measure the same users. Rejected as too lossy for a
  single-month validation window where the sample is small and the metric is the point.
- **No telemetry at all.** Rejected: it would make the MVP's central hypothesis
  unfalsifiable. Measuring is the reason for building it.
- **Disclosed opt-out** (on, with a way to turn it off). Rejected: an identifier that is sent
  before the person answers is not consent in the EU. A box that starts ticked is the same thing
  in a smaller form, and the choice that stands is two equal buttons ([ADR-0063](ADR-0063-telemetry-v2.md) section Alternatives).
- **Silent opt-out** (no first-run disclosure). Rejected. It retains essentially the same data
  as *disclosed* opt-out while carrying all of the reputational risk, and is strictly dominated.
- **A third-party analytics SaaS** (Google Analytics, Mixpanel, PostHog Cloud). Rejected
  outright: it would hand user data to a party neither Orivon nor the user chose, in a product
  whose thesis is removing such parties. Fatal on discovery.
- **Hardware-derived install ID** (MAC hash, machine GUID). Rejected here: that is a device
  fingerprint, and it survives reinstall. ADR-0063 reverses this for the metric's sake, with a
  keyed one-way hash read only after consent.

## Reasoning
In a population of 100, "anonymised" carries less weight than it sounds: country plus
usage-hour patterns plus a stable ID is re-identifiable in principle. The payload is therefore
held to the minimum that can still compute the metric, and nothing is collected "in case it is
useful later".

An explicit first-run choice does the work that opt-in and opt-out each do half of. It is
consent a European regulator can accept, because nothing is sent and nothing is preselected until
the person answers. It keeps far more data than opt-in, because the question is asked once, on
the first screen, with the literal payload beside it, instead of being buried in Settings. Three
properties make it hold:

1. **A prominent disclosure at first run**, showing the *literal JSON* that will be sent, not a
   description of it, with the same choice offered again in Settings afterwards.
2. **Self-hosted**, so no third party is introduced.
3. **Inspectable**, meaning the browser contains a page listing everything sent so far.

The retention an explicit choice reaches is not measured here; the figure the first version gave
was a guess and is withdrawn.

## Residual risk: stated, not resolved
For this specific audience, being asked at all is itself a cost, independent of payload quality.
Someone will inspect the binary or watch the network, and the finding will circulate.

The mitigation is **sequencing, not secrecy**: state it on the landing page and in the README
**before shipping**. Announced first, it reads as transparency; discovered first, it becomes a
story. The data collected is identical either way, so there is no cost to announcing.

## Consequences
- The explicit choice keeps more installs than opt-in, by an amount not yet measured. The
  honest requirement is in the thousands of downloads, because consent, retention and activation
  all discount it; sizing it is owner-side work (`scope.md`).
- **The metric resolves around month 3.** The monthly threshold cannot be observed until ~30 days after
  ship. The build month produces a shipped product, not a measured result.
- Requires a small self-hosted ingest endpoint, the only server Orivon operates. It must not
  log IPs. (ADR-0063 withdraws the promise to publish its configuration: the server's source is
  private, and the notice describes what it stores.)
- The first-run disclosure view and the in-product "what has been sent" page are real, small
  scope items and are **not optional**: they are what makes this defensible.
- Disabling telemetry must never degrade the product in any way.
- Because the ingest endpoint is the **only** server Orivon runs, it is also the only piece of
  centralised infrastructure capable of correlating users. It must be treated as
  security-sensitive out of proportion to its size.
- Pre-announcement is a **launch-blocking task**, not a nice-to-have.

## Reversibility
- **Cost to reverse:** cheap to narrow (switch to opt-in, drop fields); **expensive to widen.**
  Adding fields later, to this audience, reads as betrayal even when individually harmless.
  Any addition requires a new ADR.
- **What would make us revisit:** sustained community objection at launch, or the metric
  proving computable on less data.
