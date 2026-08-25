# ADR-0004: Opt-out, self-hosted, inspectable telemetry

- **Status:** accepted — supersedes the opt-in version (2026-08-18); **amended 2026-08-25 to a
  first-run explicit choice**, chosen by the owner for EU defensibility
- **Date:** 2026-08-18
- **Type:** product / security
- **Decided by:** **owner** (values decision); payload, delivery and disclosure per AI recommendation

> **Reversal recorded.** An earlier accepted version of this ADR specified **opt-in**. The
> owner overrode it, wanting greater measurement efficiency and more data. The AI concern is
> stated under "Residual risk" rather than removed, so the tradeoff stays visible to whoever
> reads this later.

## Decision
Orivon ships usage telemetry that is **self-hosted**, **minimal**, **inspectable in the
product**, and enabled through a **first-run explicit choice**: the disclosure screen shows
the literal payload with two equal buttons — **[Keep on] / [Turn off]** — and no preselected
default. Nothing is sent before the user chooses. No third-party analytics service is used,
ever.

*(Amendment rationale, 2026-08-25: the metric targets EU users, and an install UUID is an
"online identifier" under GDPR — pure opt-out sat in gray territory a privacy-branded browser
cannot afford. An explicit choice retains an estimated 85–90% of installs and is defensible
as consent, so it keeps nearly all the data with none of the gray zone.)*

**The entire payload** (revised 2026-08-25 after the audit):
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
   (owner decision). The previous `durationSec` measured how long the app was *open* — and a
   torrent client seeds in the background by design, so 25 h/month was satisfiable by a user
   who pasted one magnet and walked away. The metric could not distinguish a daily driver from
   an idle process, making the central hypothesis unfalsifiable in its own favour.
2. **Monthly aggregate replaces the session array.** Per-session `startedAt` against a stable
   ID, over months, is a daily activity pattern — waking hours, working hours, real timezone —
   materially more identifying than `country`, and unnecessary: the metric needs a sum, not a
   timeline. Send once per period at a randomised offset; do not queue-and-retry into a backlog
   that reconstructs the timeline just removed.
3. **`country` is self-declared.** It was the only reason the endpoint touched the IP at all,
   and "the IP is discarded at ingest" was the single claim in the whole design that a user
   could not verify locally — TLS terminates somewhere that sees the IP regardless. Asking
   directly removes the unverifiable promise instead of asserting it harder.

**Also required:** the client **ignores the response body entirely** — no server-driven config,
no kill switch, no remote command channel. Otherwise the only server Orivon runs is one
compromise away from controlling every install. And session accounting must checkpoint
periodically, so a crash loses minutes rather than a whole session.

**Never collected:** URLs, magnet links, infohashes, search queries, peer addresses, file
names, Nostr pubkeys, IP addresses (beyond momentary use at ingest), or any device
fingerprint.

## Context
The MVP's success metric is **100 active users in EU/USA at 25 hours/month each**. That
cannot be validated without per-user monthly usage data, so *some* stable identifier and
*some* duration measurement are unavoidable. The target audience — Monero, Tor and
Bitcoin-maximalist users — is the most telemetry-hostile population on the internet and will
actively look for this.

Owner's position: anonymised, non-invasive data (country and usage) is acceptable, and
measurement efficiency matters more than the opt-in ceremony.

## Alternatives considered
- **Opt-in (previously accepted, now rejected by the owner).** Converts 30–60%, which would
  have required 200–300 installs to measure 100 users. Rejected as too lossy for a
  single-month validation window where the sample is small and the metric is the point.
- **No telemetry at all.** Rejected: it would make the MVP's central hypothesis
  unfalsifiable. Measuring is the reason for building it.
- **Silent opt-out** (no first-run disclosure). Rejected. It retains essentially the same data
  as *disclosed* opt-out while carrying all of the reputational risk — strictly dominated.
- **A third-party analytics SaaS** (Google Analytics, Mixpanel, PostHog Cloud). Rejected
  outright: it would hand user data to a party neither Orivon nor the user chose, in a product
  whose thesis is removing such parties. Fatal on discovery.
- **Hardware-derived install ID** (MAC hash, machine GUID). Rejected: that is a device
  fingerprint, and it survives reinstall — the opposite of anonymous.

## Reasoning
In a population of 100, "anonymised" carries less weight than it sounds: country plus
usage-hour patterns plus a stable ID is re-identifiable in principle. The payload is therefore
held to the minimum that can still compute the metric, and nothing is collected "in case it is
useful later".

Given opt-out, three properties do the work that opt-in would otherwise have done:

1. **Prominent disclosure at first run**, showing the *literal JSON* that will be sent — not a
   description of it — with a one-click off switch in the same view.
2. **Self-hosted**, so no third party is introduced.
3. **Inspectable**, meaning the browser contains a page listing everything sent so far.

Disclosed opt-out retains 85–95% of installs, against 30–60% for opt-in, at almost no
reputational cost relative to silent collection. The efficiency argument is therefore
satisfied without the indefensible variant.

## Residual risk — stated, not resolved
For this specific audience, *on by default* is itself the objection, independent of payload
quality. Someone will inspect the binary or watch the network, and the finding will circulate.

The mitigation is **sequencing, not secrecy**: state it on the landing page and in the README
**before shipping**. Announced first, it reads as transparency; discovered first, it becomes a
story. The data collected is identical either way, so there is no cost to announcing.

## Consequences
- The explicit choice retains an estimated **85–90%** of installs, against 30–60% for opt-in.
  **The former "115–130 installs" consequence is withdrawn as wrong** — it applied the consent
  rate and nothing else, with no retention and no activation. The honest requirement is in the
  thousands of downloads; sizing it is owner-side work (`mvp-scope.md`).
- **The metric resolves around month 3.** 25 h/month cannot be observed until ~30 days after
  ship. The build month produces a shipped product, not a measured result.
- Requires a small self-hosted ingest endpoint — the only server Orivon operates. It must not
  log IPs, and that should be verifiable from its published configuration.
- The first-run disclosure view and the in-product "what has been sent" page are real, small
  scope items and are **not optional** — they are what makes this defensible.
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
