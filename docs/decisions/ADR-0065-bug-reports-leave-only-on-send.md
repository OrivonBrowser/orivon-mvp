# ADR-0065: Bug reports leave only on Send, with everything they hold shown first

- **Status:** accepted
- **Date:** 2026-10-07
- **Type:** product / security
- **Decided by:** **owner** (items 1 to 4); AI recommendation accepted by default (item 5)

## Decision
1. **Only on Send.** A bug report is written in a form (`orivon://report`) and leaves only when
   the person presses Send. Nothing is sent by itself, after a crash or otherwise. The form shows
   the literal body before it goes, report ID included, built by the main process from facts and
   log lines taken once per form, so the preview is what is sent.
   Each report is its own consent; it does not depend on the telemetry choice, and it carries a
   random report identifier, never the telemetry install identifier (d-0555).
2. **One message, one deletion.** `POST /v1/report` on the telemetry server, schema 1:
   `reportId`, `description`, `contact`, `version`, and four optional parts, each `null` when left
   out: `crash` (the recorded problem: kind, time, process, reason, exit code, message, stack),
   `diagnostics` (build, system, graphics, screens, process memory, windows and tabs, extensions,
   an allowlist of settings, recent problems), `log` (Orivon's last log lines) and `page` (the
   crashed tab's address), plus `dump`. `POST /v1/report-erase` with the report ID deletes it. The
   client reads only the status of either answer. The fields are listed in
   [`notice.md`](../privacy/notice.md) section Bug reports you send, and a unit test compares that table
   with the payload.
3. **Crash dumps are opt-in.** Electron's crash handler (Crashpad) runs with its upload switched
   off, so native crash dumps stay in the profile. A dump goes with a report only when the person
   ticks its box, which is never ticked when the form opens; at most 5 MB (d-0556).
4. **What the browser keeps to make a report useful.** In the profile's `diagnostics` folder: the
   main process's log of this run and the previous one, records of the last 30 problems (a
   main-process error, a renderer or child process that stopped, an exit that was not orderly)
   kept 30 days, and the newest 10 crash dumps kept 30 days. A private session's folder goes when
   the session ends, and no page address is recorded for it.
5. **Defaults the owner did not set** (*provisional*: settled by the legal review the DPIA
   screening asks for): **Technical details** and **Recent log** are ticked when the form opens, the
   log not in a private window; the page address and the dump are not. A report is sent even under `ORIVON_TELEMETRY=off`, which
   governs telemetry, because a report is the person's own act. The server takes at most 6 reports
   an hour per address, 500 a day, and 2 GB of dumps (d-0559).
6. **Retention and recipients.** The server keeps a report, with its dump, 90 days from the day it
   arrives. The maintainers read reports, and may give one to an AI coding assistant, today Claude
   by Anthropic PBC in the United States, to find the cause; the form says so beside Send, and the
   transfer rests on the sender's explicit consent, GDPR Article 49(1)(a) (d-0558). Whether a
   processing agreement covers it is [A408](../open-questions.md).
7. **`NOTICE_VERSION` stays 4.** The version tracks what the telemetry consent covers. Bug reports
   add a section to the notice without changing telemetry, so no telemetry acceptance is voided and
   nobody is asked again (d-0557).

## Context
The owner asked for crash and bug reports that carry what a developer, or an AI assistant, needs
to fix a problem from the report alone, with a description written by the person. The browser
kept no log and no crash record: a main-process error printed to standard error and exited, a
crashed tab kept only its reason, and no native dump was written. The telemetry server and its
privacy notice existed (ADR-0063, ADR-0064), so the report reuses the server, the TLS front end
and the rules about addresses and days.

## Alternatives considered
- **Automatic crash upload for people who accepted telemetry.** Rejected by the owner: a crash
  report holds far more than usage counters (a call stack, log lines, possibly a page address), so
  it would widen the telemetry consent, bump the notice and ask everyone again, and the person
  would not see what left.
- **Ask after each crash, with an "always send" box.** Rejected for the same reason once the box is
  ticked, and it adds a prompt after every crash.
- **No native dumps.** Simpler and safer, but a native crash, such as a segmentation fault in the
  main process, would arrive with no stack at all. Kept, behind an unticked box.
- **A dump ticked by default.** Rejected: a pre-ticked box over a memory snapshot is the shape
  *Planet49* (C-673/17) rules out for consent.
- **Bumping `NOTICE_VERSION`.** Rejected by the owner: it would void every telemetry acceptance
  for a change that does not touch telemetry.
- **Linking a report to the telemetry install ID.** It would tell which install reports what, but
  it would tie a free-text report and a log to a stable device identifier, and make a report from
  someone who declined telemetry impossible or inconsistent. A random report ID serves follow-up.
- **A third-party crash service** (Sentry and the like). Rejected: a processor for every report
  and a second place that holds them, where the server already exists in the EU.

## Reasoning
A report is useful only with its technical context, and lawful only if the person knows what it
holds. Showing the literal body, built where it is sent from, makes those one thing: the person
consents to exactly what they see, and the developer gets everything they agreed to. The log and
the crash records are local and bounded, so they cost nothing until a report is sent. Crashpad
with uploads off is Electron's own mechanism (Rule 6), and the dump is the one part the form cannot
show, which is why it alone needs a separate, unticked choice.

## Consequences
- A crash handler process runs beside every Orivon process tree, and up to 10 dumps sit in each
  profile.
- The main process's console output is also written to a file in the profile; a line logged by
  Orivon's code can name a page or a file, and that file is kept for one run after this one.
- The server stores free text and memory snapshots for the first time. Its body limit for this one
  route is 8 MB, and a full dump store refuses new reports with dumps.
- The notice names Anthropic as a recipient; a change of AI provider is a notice change.
- Reports are not encrypted beyond TLS in transit and the server's disk.

## Reversibility
- **Cost to reverse:** cheap for the defaults and the limits; moderate for removing dumps or the
  AI recipient (a notice change, and reports already sent stay until their 90 days end).
- **What would make us revisit:** the legal review of the notice; A408's answer; reports arriving
  without enough to fix the problem, or with more personal data than they need; abuse of the
  endpoint beyond the per-address limit.
