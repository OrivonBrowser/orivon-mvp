# ADR-0095: The opt-in usage report names the app a tagged installer opened on first run

- **Status:** accepted; widens [ADR-0063](ADR-0063-telemetry-v2.md) and [ADR-0064](ADR-0064-telemetry-country-and-start-send.md) by one field
- **Date:** 2026-10-21
- **Type:** product / security
- **Decided by:** **owner**

## Decision
1. **One more field.** The usage report carries `flavour`: the id of the app a tagged installer
   opened on the profile's first run ([`ADR-0093`](ADR-0093-an-installer-file-name-or-switch-selects-an-apps-first-run-presets-from-an-allowlist.md)),
   or `null` when there was none. It is always present in the message, so the layout is fixed.
2. **Only an allowlisted id, never text.** The browser reads the id from the profile's
   `flavour.json` and sends it only if it is an entry of `resources/flavours.json`; the message
   builder drops anything that is not 2 to 24 lowercase letters and digits. The installer's file
   name, the switch's text, an address and a download location are never sent. A damaged or edited
   `flavour.json` reads as `null`.
3. **Only inside the opt-in report.** It rides in the usage report, which is built and sent only
   while telemetry is on. The site report and the erase request do not carry it. Nothing changes
   for a private window, a development build or `ORIVON_TELEMETRY=off`.
4. **Payload schema 5, notice version 5.** Schema 5 is schema 4 plus `flavour`. The server accepts
   schemas 2 to 5 and stores `flavour` in the usage row, constrained to the same id shape, NULL for
   every older schema. A browser sends schema 5 only in a release made after the server accepts it.
5. **The notice re-asks.** `NOTICE_VERSION` goes to 5 with a `NOTICE_CHANGES` line, so an
   acceptance given under notice 4 reads as undecided and the next start asks again with that line,
   as [`ADR-0063`](ADR-0063-telemetry-v2.md) item 9 and d-0553 require of any further field. A
   refusal is left alone and waits out its six months.
6. **Erase covers it.** The erase request carries the install ID and the server deletes the usage
   rows by it, so the field goes with the row. Aggregation after 12 months keeps a count of
   installs per app and month with no install ID; the server's report prints a count under 5 as
   "<5".

## Context
A release reaches people over IPFS addresses as well as over a web server, and the project cannot
count a fetch from a peer. The profile itself is the one place that knows which tagged installer it
started from, and the usage report is the one message already allowed to describe the install. The
owner wants to know which entries of the shipped list people actually install through, to keep or
cut them.

## Alternatives considered
- **Carry the field under schema 4.** Rejected: the server checks the exact key set of each
  schema and answers 400 to an unknown key, so a schema 4 report with `flavour` is dropped whole.
- **A separate message for it.** Rejected: one more request and one more thing to join by install
  ID, for a value that belongs to the install.
- **The installer's file name as sent text.** Rejected: a file name is chosen by whoever hands the
  file over; only an id from the shipped list is ever sent.
- **Not re-asking, because the field is coarse.** Rejected: the rule of ADR-0063 is that any
  widening re-asks, and the notice's field table must stay equal to the payload (a unit test
  compares them).

## Reasoning
The id is one of six public words, set once and tied to nothing else about the computer, and it
reaches the server only inside a report the person turned on after reading the notice that lists it.
Applying the existing widening rule unchanged costs a second consent question for everyone who
accepted before, which is the price of keeping the rule one rule.

## Consequences
- Everyone who accepted under notice 4 sends nothing until they answer again, as after ADR-0064; the
  measured active-user count dips until they do.
- The per-install rows split into smaller groups (country by app). For a small population an app
  with a few installs in one country narrows who they are in the rows and in the monthly counts that
  outlive them; the DPIA screening notes it.
- Order of release: the server accepting schema 5 goes live first, then a browser release that
  sends it. A browser sending schema 5 to a server that does not accept it loses its usage reports.
- Documents made true with this ADR: `docs/privacy/*`, `src/telemetry/README.md`,
  `src/main/flavour/README.md`.

## Reversibility
- **Cost to reverse:** cheap: dropping the field is a narrowing, with another notice version bump
  (and, for the ones who accepted under 5, no re-ask is needed for a narrowing); the server keeps
  accepting schema 5.
- **What would make us revisit:** a measured fall in consent from the second question, the list
  growing to where an app narrows an install, or counsel finding the field needs more than the
  consent already asked.
