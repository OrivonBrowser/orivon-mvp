# Record of processing activities (GDPR Article 30)

This record covers what Orivon holds as controller: what reaches its own server. Requests the
browser makes to servers Orivon does not operate are listed in
[`outbound-requests.md`](outbound-requests.md); Orivon receives nothing from them and holds no
record of them.

| | |
|---|---|
| Controller | [CONTROLLER] |
| Contact | [CONTACT] |
| Data protection officer | None designated |
| Joint controllers, processors | None. The server is run by the controller itself |

## Activity 1: product telemetry

| | |
|---|---|
| Purpose | Measure active use of the browser (the 25 hours a month metric in the EU and USA) and which classes of site the time is spent on, to decide what to build and to judge the project |
| Legal basis | Consent, GDPR Article 6(1)(a), and ePrivacy Directive Article 5(3) for reading the machine ID and keeping the identifier on the device. Given by a checkbox on the first screen or the Settings switch; withdrawn by the same switch; a stored consent under an older notice version is void |
| Data subjects | People who turn telemetry on in Orivon Browser, worldwide; the aim is the EU and the USA |
| Categories of data | A pseudonymous install identifier derived from the machine ID by a one-way hash; a random per-profile stream value; region (EU, US or other, from the time zone); browser version; month; active and background seconds; active seconds per site class; in a separate message with no install identifier, a random monthly report identifier and active seconds per named Web3 or Web2.5 site. The full field list is in [`notice.md`](notice.md) §What telemetry sends |
| Special categories | Not collected. A named site could suggest an interest by inference (see [`dpia-screening.md`](dpia-screening.md)); that is why per-site data is unlinked from the install identifier |
| Not collected | Page addresses, paths, search text, page titles, bookmarks, credentials, file names, advertising identifiers, an ordered or timed list of visits. The IP address is not written to disk |
| Recipients | None. The only persons with access are the project's maintainers |
| Transfers outside the EU | None. Self-hosted on a virtual server in the EU (OVH; provisional until the hosting contract and region are confirmed) |
| Retention | Usage rows per install and month: 12 months, then folded into monthly aggregates that carry no install identifier. Site reports: kept for the month; one month after the month closes they are folded into per-site monthly totals for all users and deleted. A request to erase deletes the rows for an install identifier at once |
| Source of the data | The data subject's own browser; nothing from third parties |
| Rights handling | Access and erasure by the in-product Delete my data button, or by writing to [CONTACT] with the install identifier shown in Settings; withdrawal in Settings. Site reports cannot be found by install identifier, so they cannot be erased individually; they are in the totals after the period above |
| Automated decisions | None |

### Security measures

Provisional until the server is deployed and these are checked on it; each is a design
requirement of [`ADR-0063`](../decisions/ADR-0063-telemetry-v2.md).

- TLS to the endpoint; the front end keeps no access log.
- Strict validation of every message (types, ranges, key characters, at most 300 sites); a body
  larger than 32 KB is refused.
- A per-address rate limit held in memory only and lost on restart; no address is stored.
- The service runs under a dynamic unprivileged user with a memory cap and a state directory of
  its own; the database is a local file readable by that user only.
- No receive time finer than the day is stored.
- The client ignores every response body, so a compromise of the server cannot command a browser.
- The ingest keys usage rows by install identifier, period and stream, and site rows by report
  identifier and period; the two tables hold no common key.

### Review

Reviewed whenever a payload field, a retention period, the hosting or the controller changes, and
at least once a year. The notice version number and this record change together.

## Other processing as controller

None known. Two items need the owner to confirm, because they are run by the project and not by a
third party, and this record cannot settle them from the code:

- **The official Web3 Score provider and the IPFS pinning node that serve it.** The browser asks
  them for a hash bucket of a page (see [`outbound-requests.md`](outbound-requests.md) row 10).
  Whether those servers keep request logs, and for how long, is not recorded here. If they do, it
  is a second activity of this record.
- **Release hosting.** Downloads and the update check go to GitHub, which is its own controller.
