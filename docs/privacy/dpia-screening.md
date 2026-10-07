# DPIA screening for product telemetry and bug reports

A screening, not a full impact assessment: it asks whether one is required under GDPR Article 35,
using the nine criteria of the Article 29 Working Party guidelines WP248 (endorsed by the EDPB).
Two or more met usually means a DPIA is needed. Scope: the telemetry and the bug reports described
in [`notice.md`](notice.md) and [`record-of-processing.md`](record-of-processing.md); the bug
reports have [their own screening](#bug-reports) below.

## The criteria

| # | Criterion | Met? | Why |
|---|---|---|---|
| 1 | Evaluation or scoring, including profiling | No | The seconds counted describe the browser's use, not a judgement of a person. The Web3 Score rates sites, not people, and is not sent |
| 2 | Automated decisions with legal or similar effect | No | No decision is made about anyone |
| 3 | Systematic monitoring | Partly | Active and background seconds are counted continuously and sent daily and at each browser start and quit. It is measurement of use of one product, not of a public place or of what the person reads, and it is off until the person chooses to share |
| 4 | Sensitive data or highly personal data | Partly | No special-category data is collected. A site name could suggest one by inference (a site about health, politics or religion that has a public Web3 or Web2.5 name). The named-site seconds of one install, linked to its identifier for at most two months, are the nearest thing to this |
| 5 | Large scale | No | A small population of active users. Re-screen if that grows by an order of magnitude |
| 6 | Matching or combining datasets | No | The usage and site reports share one install identifier because they serve one telemetry purpose, have one controller and are both disclosed. WP248 criterion 6 is about datasets from different processing operations or different controllers; nothing is joined with other sources |
| 7 | Vulnerable data subjects | No | Adult users of a technical product; no children or employees are targeted |
| 8 | Innovative use or new technology | No | A counter and a hash. Not novel |
| 9 | Prevents people exercising a right or using a service | No | Declining changes nothing in the browser. The first screen offers two equal buttons, neither preselected |

## Result

**A full DPIA is not required for the design as it stands**, because at most criteria 3 and 4 are
partly met, the data are counters, consent is an active, unambiguous choice and withdrawable, the volume is small, and the
named-site rows keep the identifier for at most two months. The margin is narrow, and this result is *provisional*: the legal review before a public launch
settles it. It is a close call on three points, and the record says so rather than hiding them:

1. **The install identifier is derived from the machine's own ID.** It is a one-way hash, so the
   machine ID cannot be read from it, and it is made only after consent. But it is a stable device
   identifier: the same on every profile, and it survives a reinstall of the browser. Anyone who
   knows the machine ID of a computer (any program running on it can read it) and the derivation
   can compute the identifier for that computer. It is treated as personal data for that reason.
   It is the reason the identifier is limited to counters and to named-site seconds for at most two months.
2. **The per-site report is the closest thing to browsing information.** It carries the install
   identifier, so for the month and the month after, the sites one computer spent time on are
   linked to it, and for a small population a rare site name could narrow who that is. After that
   the rows are folded into totals with no identifier. The IP address is not written to disk (it
   is held in memory only, for a per-address rate limit), and the public name rule keeps ordinary
   Web2 sites out of it altogether.
3. **The usage report names the country of the time zone.** A country is coarser than any
   address and is worked out on the computer, but in a small population a country with one or
   two installs narrows who they are, in the per-install rows and in the monthly totals that
   outlive them. The rows are pseudonymous and the totals carry no identifier; this is why a
   country with very few installs is a reason to re-screen.

## Bug reports

| # | Criterion | Met? | Why |
|---|---|---|---|
| 1 | Evaluation or scoring | No | A report describes a fault of the browser, not the person |
| 2 | Automated decisions | No | None |
| 3 | Systematic monitoring | No | Nothing is collected unless the person writes a report and presses Send, once per report |
| 4 | Sensitive or highly personal data | Partly | Nothing sensitive is asked for, but the description is free text, a log line or the page address can name a site, and a crash dump is a memory snapshot that can hold fragments of what was open or typed. The address and the dump are unticked by default, and every report is deleted after 90 days |
| 5 | Large scale | No | A few reports from a small population of active users |
| 6 | Matching or combining datasets | No | A report carries a random identifier and is not linked to telemetry or to anything else |
| 7 | Vulnerable data subjects | No | As for telemetry |
| 8 | Innovative use or new technology | Partly | A maintainer may give a report to an AI coding assistant (Claude, by Anthropic, in the United States) to find the cause. That is a new tool, though it is used only to read a report the person chose to send, and the person is told before sending |
| 9 | Prevents exercising a right or using a service | No | Not sending changes nothing in the browser |

**A full DPIA is not required for bug reports as designed**: criteria 4 and 8 are partly met,
but each report is a separate act of the person with the content in front of them, the volume is
small, the most revealing parts are off by default, and everything goes after 90 days. Two partly
met criteria is the threshold WP248 names, so this result is *provisional* on the same legal
review as the telemetry one, and on [`open-questions.md`](../open-questions.md) A408 (the
processor terms for the AI assistant).

## Re-screen when

- Site rows are kept past one month after their month closes.
- A field is added to either message, or any per-page information is considered.
- A country's monthly totals come from so few installs that one person's use can be read from
  them.
- The number of active users grows by an order of magnitude, or the first-run choice is replaced by a preselected
  option.
- The server is moved, a processor is added, or an IP address is written anywhere.
- A bug report starts to be sent without the person pressing Send, a crash dump is ticked by
  default, reports are kept longer than 90 days, or reports are given to a second AI provider.
- A national supervisory authority's list of processing that needs a DPIA is found to include this
  processing. That list has not been checked for each country; this is not settled here.

Screening done by the maintainers, not by a lawyer. A legal review of the notice and this record
before a public launch is recommended and is not recorded as done.
