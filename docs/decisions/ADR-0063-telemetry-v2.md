# ADR-0063: Telemetry v2: site classes, one identity per machine, a consent that is a checkbox

- **Status:** accepted; supersedes [ADR-0004](ADR-0004-telemetry.md) in part (its payload, its
  install identifier and its country field). The welcome checkbox's starting state and the
  unlinking of the per-site report are **provisional** until the owner answers
- **Date:** 2026-10-06
- **Type:** product / security
- **Decided by:** **owner** for what is measured, where it goes, the two screens, one identity per
  machine and no telemetry in development builds; AI recommendation accepted by default for the
  rest, with the two items above provisional

## Decision
Telemetry keeps ADR-0004's rule (a first-run explicit choice, self-hosted, inspectable, no
response channel) and widens what is measured and how the person chooses.

1. **Measured.** Active seconds are also split into three site classes, Web3 (level 4), Web2.5
   (levels 2 and 3) and Web2 (level 1), from the Web3 Score level. Seconds per single site are
   counted for Web3 and Web2.5 sites that have a public name. A Web2 site is never named, never
   stored, even locally. A Web3 or Web2.5 site with no public name counts in its class and is
   sent as `(unlisted)`.
2. **Two messages.** A usage report (`POST /v1/usage`) with the install identifier, a per-profile
   stream, a region, the version, the month and the seconds. A site report (`POST /v1/sites`)
   with a random report identifier per profile and month and the per-site seconds. The site
   report carries **no install identifier** (provisional: see Reversibility).
3. **One identity per machine.** The install identifier is the first 32 hex characters of an
   HMAC-SHA-256 of the operating system's machine ID, so every profile, a run from source and an
   installed package, and a reinstall on one computer are one install. It is made, and the
   machine ID read, only after consent. Where the machine ID cannot be read, a random identifier
   in the system-wide telemetry directory is the fallback. A random **stream** per browser
   profile keeps two profiles open together summed, not collapsed.
4. **Region from the time zone** (EEA, UK and Switzerland zones: `EU`; US zones: `US`; else
   `other`), replacing the self-declared country, which no screen ever set. Never from the IP
   address.
5. **The choice.** A checkbox "Telemetry" on the first-run welcome and a switch in Settings,
   bound to one consent per operating-system user, kept under the user's config directory and
   read fresh on every send, so every profile obeys it. The checkbox starts **unticked in the
   EU region and ticked elsewhere** (provisional). It is hidden when the consent is already
   decided. A refusal is not asked again for six months.
6. **Cadence.** A month-to-date snapshot at most once a day, upserted by the server, with the
   closing snapshot of a month sent once after it ends. Nothing queues beyond one message.
7. **Erase.** `POST /v1/erase` with the install identifier, from a "Delete my data" button that
   also turns telemetry off.
8. **Where it never runs.** Development builds (`npm run dev`), a private window, and any run with
   `ORIVON_TELEMETRY=off` start no measuring, read no machine ID and send nothing.
9. **`NOTICE_VERSION`.** A stored acceptance whose notice version differs from the code's counts
   as undecided, so a change to the payload or the notice asks again.
10. **Retention.** Per-install rows 12 months, then only aggregates; site reports folded into
    monthly per-site totals one month after the month closes.

The server is `https://telemetry.orivonstack.com`, a VPS in the EU, outside this repository.
The notice is [`docs/privacy/notice.md`](../privacy/notice.md).

## Context
The success metric is 100 active users in EU/USA at 25 hours a month (Rule 4). One identifier per
install counted a person with two profiles, or a source and a packaged run, as several, and
overstated the base. The owner also wants to know what kind of site the time goes to, since the
product's claim is Web3 and Web2.5 use, and which single sites those are. The owner asked for the
checkbox on the first screen and the switch in Settings, the endpoint on the owner's own server,
and no data from development runs, which are the maintainers' own.

The legal frame is the privacy handoff: GDPR Article 13 notice, an Article 30 record, a DPIA
screening and ePrivacy Article 5(3).

## Alternatives considered
- **A random per-profile identifier, as ADR-0004 required.** Lost to the metric: it counts one
  person as several. The cost accepted is ADR-0004's own objection, a device-derived identifier
  that survives a reinstall; the answers are the one-way keyed hash, reading it only after
  consent, keeping it out of the per-site message, and the erase button.
- **Per-site seconds inside the usage report (linked).** It gives the cleanest per-person
  picture and is the simplest server. Not chosen by default because a stable identifier plus a
  list of named sites is a browsing profile; unlinked, it is a month's set of sites for a random
  identifier. Provisional: the owner may choose linked (below).
- **Ticked by default everywhere.** Rejected for Europe: the Court of Justice held in *Planet49*
  (C-673/17) that a pre-ticked box is not consent to storing or reading information on a device,
  and Article 5(3) of the ePrivacy Directive and Article 4(11) of the GDPR ask for an active
  choice. Reading the machine ID is such access. Kept ticked elsewhere because no law this project
  has identified requires prior consent for this data there, and a higher consent rate serves the
  metric. This is a choice, not a legal need, and it is provisional.
- **Unticked everywhere.** Safer, with the lowest consent rate; the owner has not asked for it.
- **Region from the IP address at the server.** Rejected: it would make the server read the address
  to store a field, the unverifiable promise ADR-0004 removed.
- **A time zone is not residence.** An EU resident whose computer is set to a US zone gets the
  ticked default, and the reverse. Accepted as best effort: the person still sees the checkbox and
  the notice, and the choice is theirs either way.
- **Monthly send only.** Rejected: an uninstall or a crash mid-month loses the whole month, and the
  25-hour threshold could not be read until the month closes.
- **Telemetry in development builds.** Rejected by the owner: those runs are the maintainers' own.

## Reasoning
Every part serves the metric and stays inside the law. Classes and per-site seconds are counters
of time, with no address, query or timeline. The machine identity is the smallest change that
makes "one person" true. Unticked in the EU follows *Planet49*; the cost is a lower consent rate
there, to be measured, not guessed. The daily upsert makes a mid-month read possible and makes
repeats harmless. The notice, the in-product view of the literal messages and the erase button
are what make the consent informed and the withdrawal as easy as the agreement.

## Consequences
- A third message, an erase endpoint and a per-profile stream make the payload larger than
  ADR-0004's; `NOTICE_VERSION` voids a stale consent whenever it changes, which asks every person
  again.
- The EU consent rate under an unticked box is lower than ADR-0004's estimate for an explicit
  choice. It is unmeasured; sizing it stays owner-side.
- The identifier is a stable device identifier. It must be treated as personal data, and the
  notice says so (`docs/privacy/dpia-screening.md` §Result).
- The system-wide consent means one choice applies to every profile of an operating-system user,
  and a profile cannot opt out alone.
- Time-zone region is wrong for some people. It is a count by region, not an identity.
- A server must exist at `telemetry.orivonstack.com` with the retention timer; until it does the
  browser's messages go nowhere, and nothing waits.
- Documents made true with this ADR: `docs/privacy/*`, `src/telemetry/README.md`, ADR-0004's
  title and Reasoning, the root `README.md`'s telemetry statement.

## Reversibility
- **Cost to reverse:** cheap to narrow (drop per-site, make the box unticked everywhere); expensive
  to widen, as ADR-0004 says: any further field needs a new ADR and a notice version bump.
- **What would make us revisit:** the owner's answers on the welcome default and on linking the
  per-site report; a supervisory authority or counsel finding the machine-derived identifier needs
  more than consent; the consent rate in the EU making the metric unmeasurable; or a measured
  collision where one identifier covers two people (a cloned machine image shares a machine ID).
