# ADR-0063: Telemetry v2: site classes, one identity per machine, an active choice

- **Status:** accepted; supersedes [ADR-0004](ADR-0004-telemetry.md) in part (its payload, its
  install identifier, its country field, and its promise to publish the ingest configuration).
  **Superseded in part by [ADR-0064](ADR-0064-telemetry-country-and-start-send.md)**: item 4's
  region (the payload names the country) and item 6's cadence (both reports also go at start).
  Item 9's provisional "the welcome does not ask again" is settled by d-0552: an acceptance under
  an older notice is asked again at the next start
- **Date:** 2026-10-06
- **Type:** product / security
- **Decided by:** **owner**

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
   under the same install identifier and stream, with the per-site seconds (d-0545). The server
   refuses per-site data inside a usage report, counts a site report only when a usage report of
   the same install, stream and month accounts for its seconds, and refuses an install identifier
   found sending forged ones for 12 months.
3. **One identity per machine.** The install identifier is the first 32 hex characters of an
   HMAC-SHA-256 of the operating system's machine ID, so every profile, a run from source and an
   installed package, and a reinstall on one computer are one install. It is made, and the
   machine ID read, only after consent. Where the machine ID cannot be read, a random identifier
   in the system-wide telemetry directory is the fallback. A random **stream** per browser
   profile keeps two profiles open together summed, not collapsed.
4. **Region from the time zone** (EEA, UK and Switzerland zones: `EU`; US zones: `US`; else
   `other`), replacing the self-declared country, which no screen ever set. Never from the IP
   address.
5. **The choice is active.** The first-run welcome shows a block titled "Telemetry" with two
   buttons of identical look and size, "Enter and share telemetry" and "Enter without
   telemetry". Neither is preselected, and the person must press one to enter. The block is shown
   only while the choice is undecided. Settings has an on/off switch. Both are bound to one
   consent per operating-system user, kept under the user's config directory and read fresh on
   every send, so every profile obeys it. A refusal is not asked again for six months. The
   region never drives a default.
6. **Cadence.** A month-to-date snapshot of each message when the person turns telemetry on and
   when the browser quits, and about once a day between, upserted by the server, with the
   closing snapshot of a month sent once after it ends: at a month's start, one more of each
   (d-0546). The acceptance and the quit skip the random offset and the daily gate; the quit
   shares the two-second bound of the other quit work. Nothing queues beyond one message.
7. **Erase.** `POST /v1/erase` with the install identifier, from a "Delete my data" button that
   also turns telemetry off. It deletes the usage rows and the site reports of that identifier
   (d-0545).
8. **Where it never runs.** A private window and any run with `ORIVON_TELEMETRY=off` start no
   measuring, read no machine ID and send nothing. A development build (`npm run dev`) runs all of
   it but sends to `https://telemetry.invalid/v1/`, which never answers, so nothing reaches the
   server (d-0544).
9. **`NOTICE_VERSION`.** A stored acceptance whose notice version differs from the code's counts
   as undecided, so after a change to the payload or the notice nothing is sent until the person
   turns telemetry on again in Settings. The welcome does not ask again, since it shows once per
   profile; a prompt for that case is not built (*provisional*: settled when a version bump
   first happens with real users).
10. **Retention.** Per-install usage rows 12 months, then only aggregates; site reports, which
    carry the install identifier until then, folded into monthly per-site totals with no
    identifier one month after the month closes, and every site row deleted (d-0545). An
    excluded install identifier is kept 12 months.

11. **Where it runs.** `https://telemetry.orivonstack.com`, an OVH SAS virtual server in
    Strasbourg, France, so nothing leaves the EU. Caddy terminates TLS with no access log; a
    Python service stores rows in SQLite; no IP address or User-Agent is written to disk; the
    address is held in memory only for a limit of 30 requests per 10 minutes; one UTC day is
    stored per row; a daily job applies the retention above. Erase deletes every usage row and
    every site report of an install identifier.
12. **The server's source is private.** ADR-0004 promised that the ingest configuration would
    be published so that "no IP is logged" could be checked. That promise is withdrawn: the
    owner keeps the server's source private. What replaces it is the description of storage,
    retention and security in [`docs/privacy/notice.md`](../privacy/notice.md) and
    [`record-of-processing.md`](../privacy/record-of-processing.md), which the controller answers
    for, and the client's own source, which shows exactly what leaves the computer. A person who
    wants to check the server's claims can only read what the notice says; that is the cost.

## Context
The success metric counts active people (Rule 4). One identifier per
install counted a person with two profiles, or a source and a packaged run, as several, and
overstated the base. The owner also wants to know what kind of site the time goes to, since the
product's claim is Web3 and Web2.5 use, and which single sites those are. The owner asked for a
choice on the first screen and a switch in Settings, the endpoint on the owner's own server, and
no data from development runs, which are the maintainers' own.

The legal frame is the privacy handoff: GDPR Article 13 notice, an Article 30 record, a DPIA
screening and ePrivacy Article 5(3).

## Alternatives considered
- **A random per-profile identifier, as ADR-0004 required.** Lost to the metric: it counts one
  person as several. The cost accepted is ADR-0004's own objection, a device-derived identifier
  that survives a reinstall; the answers are the one-way keyed hash, reading it only after
  consent, keeping the named sites linked to it for two months only, and the erase button.
- **Per-site seconds inside the usage report.** The simplest server. Rejected: the named sites
  would stay as long as the usage row, 12 months, where a separate site report is folded into
  totals with no identifier after two months.
- **A site report under a random report identifier, linked to nothing.** Rejected (d-0545): a
  forged report could not be told from a real one, counted once per reporter or erased, and
  anyone could skew the per-site totals by posting. The linked report lets the server check each
  site report against its usage report and delete an install that forges.
- **A checkbox, ticked or unticked, beside the Enter button.** A pre-ticked box is not consent:
  the Court of Justice held in *Planet49* (C-673/17) that a pre-ticked box does not give valid
  consent to storing or reading information on a device, and Article 4(11) of the GDPR asks for an
  unambiguous act. Reading the machine ID is such access. An unticked box is valid but passive:
  most people press Enter without touching it, so the acceptance falls well below what the metric
  needs.
- **A region-dependent default** (unticked in Europe, ticked elsewhere). Rejected: a time zone is
  not residence, so it would give the wrong default to some people in both directions, and
  ticking anywhere needs a legal case. The region stays in the payload for the metric but
  decides nothing.
- **Region from the IP address at the server.** Rejected: it would make the server read the address
  to store a field, the unverifiable promise ADR-0004 removed.
- **Monthly send only.** Rejected: an uninstall or a crash mid-month loses the whole month, and the
  25-hour threshold could not be read until the month closes.
- **Telemetry in development builds.** Rejected by the owner: those runs are the maintainers' own.

## Reasoning
Every part serves the metric and stays inside the law. Classes and per-site seconds are counters
of time, with no address, query or timeline. The machine identity is the smallest change that
makes "one person" true. The daily upsert makes a mid-month read possible and makes repeats
harmless. The notice, the in-product view of the literal messages and the erase button are what
make the consent informed and the withdrawal as easy as the agreement.

**Why an active choice and not a box.** Consent must be an unambiguous act. *Planet49* rules out
a pre-ticked box, and an unticked one is valid but passive: people press Enter without
touching it, so the sample would be a fraction of what the metric needs. A forced choice, two
buttons and nothing to leave as found, is valid consent and costs one press the person makes
anyway to enter, so acceptance is expected to approach what an opt-out would give, which is
better than a passive box can. The estimate is unmeasured. The buttons look identical in style
and size, with no highlighted option, because the EDPB's guidelines 03/2022 on deceptive design
patterns treat a nudge toward one answer as undermining a consent that is meant to be free. Region
stays in the payload for the metric, from the time zone, and decides nothing in the interface.

## Consequences
- A third message, an erase endpoint and a per-profile stream make the payload larger than
  ADR-0004's; `NOTICE_VERSION` voids a stale consent whenever it changes, which asks every person
  again.
- The consent rate under a forced choice is unmeasured; sizing the download count it implies
  stays owner-side.
- The welcome cannot be dismissed without answering, which is one forced press for every new
  person; the cost is accepted for valid consent.
- The identifier is a stable device identifier. It must be treated as personal data, and the
  notice says so (`docs/privacy/dpia-screening.md` section Result).
- The system-wide consent means one choice applies to every profile of an operating-system user,
  and a profile cannot opt out alone.
- Time-zone region is wrong for some people. It is a count by region, not an identity, and no
  default depends on it.
- Nobody outside the project can read the server's source to check the notice. The notice and the
  record are the description of what it stores, and the controller answers for them.
- A server must exist at `telemetry.orivonstack.com` with the retention timer; until it does the
  browser's messages go nowhere, and nothing waits.
- Documents made true with this ADR: `docs/privacy/*`, `src/telemetry/README.md`, ADR-0004's
  title and Reasoning, the root `README.md`'s telemetry statement.

## Reversibility
- **Cost to reverse:** cheap to narrow (drop per-site, drop a class); expensive
  to widen: any further field needs a decision-log row, a notice version bump with its
  `NOTICE_CHANGES` line, and the notice's field table (d-0553).
- **What would make us revisit:** a supervisory authority or counsel finding the
  machine-derived identifier needs more than consent, or the notice needing the server's source
  published to be credible; the consent rate in the EU making the metric unmeasurable; or a measured
  collision where one identifier covers two people (a cloned machine image shares a machine ID).
