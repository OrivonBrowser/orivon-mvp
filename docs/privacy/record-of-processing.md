# Record of processing activities (GDPR Article 30)

This record covers what Orivon holds as controller: what reaches its own server. Requests the
browser makes to servers Orivon does not operate are listed in
[`outbound-requests.md`](outbound-requests.md); Orivon receives nothing from them and holds no
record of them.

| | |
|---|---|
| Controller | Davide Martinico, a natural person, the owner of the project |
| Contact | privacy@orivonstack.com |
| Data protection officer | None designated |
| Joint controllers, processors | No joint controller. The server is run by the controller itself. For bug reports only, Anthropic PBC (United States) acts as a processor when a maintainer gives a report to Claude (Activity 2) |

## Activity 1: product telemetry

| | |
|---|---|
| Purpose | Measure active use of the browser (the 25 hours a month metric in the EU and USA) and which classes of site the time is spent on, to decide what to build and to judge the project |
| Legal basis | Consent, GDPR Article 6(1)(a), and ePrivacy Directive Article 5(3) for reading the machine ID and keeping the identifier on the device. Given by pressing one of two equal buttons on the first screen ("Enter and share telemetry" or "Enter without telemetry", neither preselected) or by the Settings switch; withdrawn by the same switch; a stored consent under an older notice version is void |
| Data subjects | People who turn telemetry on in Orivon Browser, worldwide; the aim is the EU and the USA |
| Categories of data | A pseudonymous install identifier derived from the machine ID by a one-way hash; a random per-profile stream value; country (a two-letter code, or unknown, from the time zone); browser version; month; active and background seconds; active seconds per site class; in a second message under the same install identifier and stream value, the active seconds per named Web3 or Web2.5 site, linked to the install identifier for the month and the month after. The full field list is in [`notice.md`](notice.md) §What telemetry sends |
| Special categories | Not collected. A named site could suggest an interest by inference (see [`dpia-screening.md`](dpia-screening.md)); that is why per-site rows carry the install identifier for at most two months and are then folded into totals with no identifier |
| Not collected | Page addresses, paths, search text, page titles, bookmarks, credentials, file names, advertising identifiers, an ordered or timed list of visits. The IP address is not written to disk |
| Recipients | None. The only persons with access are the project's maintainers |
| Transfers outside the EU | None. Self-hosted on a virtual server rented from OVH SAS in Strasbourg, France |
| Retention | Usage rows per install and month: 12 months, then a daily job folds them into monthly aggregates that carry no install identifier. Site reports, with the install identifier: kept for the month; one month after the month closes the same job folds the counted ones into per-site monthly totals for all users, with no identifier, and deletes every site row. The 12-month exclusion list (below): an identifier found sending forged reports is refused for 12 months, then removed. A request to erase deletes every usage row and every site row of an install identifier at once |
| Source of the data | The data subject's own browser; nothing from third parties |
| Rights handling | Access and erasure by the in-product Delete my data button, or by writing to privacy@orivonstack.com with the install identifier shown in Settings; withdrawal in Settings. Per-site totals folded together for all users carry no identifier and cannot be traced to one |
| Automated decisions | None |

### Security measures

As deployed. The server's source code is not published, so this record and the notice are the
description of what it stores.

- Caddy terminates TLS for `telemetry.orivonstack.com` and keeps no access log.
- A Python service validates every message strictly (types, ranges, key characters, at most 300
  sites), refuses a body larger than 32 KB, and refuses per-site data inside a usage report.
- Site reports whose seconds a usage report of the same install, stream and month does not
  account for are not counted. An install identifier found sending forged reports goes on an
  exclusion list for 12 months, and its rows are deleted; the basis is the controller's legitimate
  interest in accurate statistics, Article 6(1)(f).
- Rows are stored in SQLite on the server. No IP address and no User-Agent is written to disk;
  the address is held in memory only, for a limit of 30 requests per 10 minutes per address, and
  is lost on restart.
- Only the UTC day is stored with a row, not the time of receipt.
- The service runs under a dynamic unprivileged user with a memory cap and a state directory of
  its own.
- A daily job folds per-install rows older than 12 months into monthly aggregates, and site rows
  into monthly per-site totals one month after the month closes.
- The client ignores every response body, so a compromise of the server cannot command a browser.
- The usage and site tables share the install identifier and stream value, and are joined only to check that a site report is accounted for by a usage report.

### Review

Reviewed whenever a payload field, a retention period, the hosting, a processor or the controller
changes, and at least once a year. The notice version number and Activity 1 change together;
Activity 2 changes with the notice's Bug reports section, whose consent is asked per report.

## Activity 2: bug reports

| | |
|---|---|
| Purpose | Find and fix the problem a person reports, with the technical details that let a maintainer reproduce it |
| Legal basis | Consent, GDPR Article 6(1)(a), given for each report by pressing Send in the report form, which shows the literal report first. The transfer to the United States below rests on explicit consent, Article 49(1)(a), asked next to the Send button with the risk named in the notice |
| Data subjects | People who send a report from Orivon Browser |
| Categories of data | A random report identifier; the person's description; optional contact details (an email address or a GitHub or Matrix name); the browser version; when the report concerns a recorded problem, its kind, time, process, reason, exit code, error message and call stack; unless unticked, technical details of the computer and browser and Orivon's recent log lines; only if ticked, the address of the crashed page and a crash dump (a memory snapshot of the crashed process). The full field list is in [`notice.md`](notice.md) §Bug reports you send |
| Special categories | Not asked for. The description, a log line, a page address or a crash dump could contain anything the person had open or typed; that is why the page address and the dump are unticked by default and the dump is kept 90 days like the rest |
| Not collected | The telemetry install identifier or anything that links a report to telemetry; the IP address is not written to disk |
| Recipients | The project's maintainers. Anthropic PBC, as a processor, when a maintainer gives a report to its Claude coding assistant to find the cause |
| Transfers outside the EU | To Anthropic PBC in the United States, for the analysis above, on the person's explicit consent (Article 49(1)(a)). Whether a data processing agreement with Anthropic covers this use is open ([`open-questions.md`](../open-questions.md) A408). Stored reports stay on the server in Strasbourg, France |
| Retention | 90 days from the day of receipt, then the report and its crash dump are deleted by the same daily job. A deletion request removes both at once |
| Source of the data | The data subject's own browser; nothing from third parties |
| Rights handling | Deletion by the **Delete from server** button beside each sent report in the form, or by writing to privacy@orivonstack.com with the report ID; access and the other rights by writing |
| Automated decisions | None |

### Security measures

- The same server, TLS front end and rules as Activity 1: no access log, no IP address or User-Agent on disk, only the UTC day stored.
- A report is validated strictly (key set, types, lengths, a crash dump must decode and start with the minidump signature), at most 8 MB with its dump and 5 MB for the dump; other requests keep the 32 KB limit.
- At most 6 reports an hour per address (in memory only), a daily cap on stored reports, and a cap on the space crash dumps take.
- Crash dumps are files readable only by the service's user. Reports are read on the server by the maintainers with a command-line tool; a report given to an AI assistant is given whole or in part by a maintainer, never by the server.

## Other processing as controller

None known. Two items are listed so they are not forgotten; the first is run by the project and not by
a third party, and this record cannot settle it from the code:

- **The official Web3 Score provider and the IPFS pinning node that serve it.** The browser asks
  them for a hash bucket of a page (see [`outbound-requests.md`](outbound-requests.md) row 10), and the provider's address is an ENS name, so a lookup of that name goes with it.
  Whether those servers keep request logs, and for how long, is not recorded here. If they do, it
  is a second activity of this record.
- **Release hosting.** Downloads and the update check go to GitHub, which is its own controller.
