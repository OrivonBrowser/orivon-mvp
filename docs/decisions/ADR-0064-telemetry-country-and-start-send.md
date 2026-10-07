# ADR-0064: Telemetry names the country, and both reports go at browser start

- **Status:** accepted; supersedes [ADR-0063](ADR-0063-telemetry-v2.md) items 4 and 6 in part
- **Date:** 2026-10-07
- **Type:** product / security
- **Decided by:** **owner**

## Decision
1. **Country, not region.** The usage report carries `country`, the ISO 3166-1 alpha-2 code of
   the operating system's time zone (`IT`, `US`), or `unknown` when the zone names no country
   (`UTC`, `Etc/GMT+5`). It replaces `region` (`EU`, `US`, `other`). The country is still worked
   out on the computer from the time zone, never from the IP address. The zone-to-country mapping
   is the runtime's own ICU region data (`Intl.Locale` time zones per region), so no table is kept
   here. The server derives the `EU`/`US`/`other` region from the country for the success metric
   (d-0550).
2. **Both reports at browser start.** The first send after the browser starts goes past the
   random offset and the daily gate, as the acceptance and the quit already do, so each run is
   bracketed by a usage report and a site report. The server upserts both by install, stream and
   month, and joins them as before; a repeat is harmless (d-0551).
3. Payload schema 4, notice version 4. A stored acceptance under notice version 3 reads as
   undecided, as ADR-0063 item 9 says.

## Context
The owner asked for the country instead of the region, and for the site report to go when the
browser opens and closes as well as daily. ADR-0063 requires a new ADR and a notice version bump
for any widening of the payload; a country is finer than a region, so it is a widening.

## Alternatives considered
- **The OS locale's country** (`app.getLocaleCountryCode()`). Rejected: many people outside the
  US run an `en_US` locale, so it measures the language setting, not where the computer is; the
  time zone is the closer proxy, and it is what the region already used.
- **A zone-to-country table in this repository** (from tzdata's `zone.tab`). Rejected: ICU in
  Electron already holds it and is updated with Electron; a copy here would drift. The cost of the
  ICU route is one scan of the two-letter codes into a zone-to-country map, about 150 ms, kept
  for the life of the process.
- **Country from the IP address at the server.** Rejected for ADR-0063's reason: the server would
  have to read the address to store a field.
- **Sending both region and country.** Rejected: the region is a function of the country, so the
  server derives it, and the payload stays one field narrower.

## Reasoning
The metric is active users in the EU and the US, and the owner wants the split by country inside
them. The time zone gives the country with no new input, no network call and no new permission.
Sending at start closes the gap a run that crashes or is killed leaves: the previous run's totals
are on disk, and the start send carries them.

## Consequences
- The country is finer than the region. For a small population, an install in a country with few
  users is easier to single out in the per-install rows and in the monthly aggregates; the DPIA
  screening is re-done for it (`docs/privacy/dpia-screening.md`).
- Everyone who accepted under notice version 3 sends nothing until they turn telemetry on again
  in Settings: the welcome does not ask again (ADR-0063 item 9, still *provisional*).
- A time zone is not residence: a traveller, a VPN user, or anyone who sets another zone is
  counted in that zone's country.
- Each browser start is one more pair of requests to the server, which sees the time of each.
  The server stores the day only.
- Documents made true with this ADR: `docs/privacy/*`, `src/telemetry/README.md`.

## Reversibility
- **Cost to reverse:** cheap: going back to the region is a narrowing, with another notice
  version bump. Dropping the start send changes nothing on the server.
- **What would make us revisit:** a country with so few installs that its aggregate rows
  identify one person, a supervisory authority or counsel finding the country needs more than
  the consent already asked, or the start send loading the server more than the daily one.
