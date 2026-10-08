# Privacy and telemetry compliance: handoff

A brief for the agent that implements it. It says what to do and why, not how. The legal
reading below is not legal advice; items marked *provisional* name what would settle them.
Written against `main` at `c3ac426e`.

## Goal and need

Make what Orivon sends, and what it says about what it sends, meet EU law (ePrivacy Art. 5(3),
GDPR) and US law (FTC Act section 5, CalOPPA, California's Opt Me Out Act) **before the telemetry
ingest endpoint is switched on**. The need (Rule 4): the success metric is measured from EU and
US users, and [ADR-0004](../decisions/ADR-0004-telemetry.md) telemetry cannot be switched on
lawfully without this work.

## Where things stand

- ADR-0004 and `d-0179`: the choice lives in Settings (usage-statistics block), two buttons,
  neither preselected; the literal payload and a history of what was sent are shown; nothing is
  sent before a choice; a private window neither measures nor sends.
- Payload: `installId` (random UUID), self-declared `country`, app `version`, `period`, per-app
  `activeSec`/`backgroundSec`. No URLs, no IP kept, no fingerprint.
- The endpoint in [`runner.ts`](../../src/telemetry/runner.ts) is a placeholder, so nothing
  leaves the device today. The ingest server does not exist yet; `scope.md` makes it the only
  server Orivon operates.
- [`store.ts`](../../src/telemetry/store.ts) keeps consent as `undecided | accepted |
  declined` only: no time of the choice, no link to the text the person saw.
- There is no privacy notice anywhere in the repository, and the root `README.md` does not
  mention telemetry, though ADR-0004 makes announcing it launch-blocking.
- GPC: the Settings toggle `privacy.globalPrivacyControl` (default off) adds `Sec-GPC: 1`
  ([`privacy-headers.ts`](../../src/main/privacy/privacy-headers.ts)).
  `navigator.globalPrivacyControl` is not exposed to pages.
- The documents disagree. ADR-0004's title and its Reasoning section say "opt-out"; its
  Decision says a first-run explicit choice; `d-0179` puts the choice in Settings with no
  first-run screen; [`src/telemetry/README.md`](../../src/telemetry/README.md) says the screens
  are not built, though Settings renders them.

## The requirements this answers

| Requirement | Source | Applies to this build |
|---|---|---|
| Consent before reading or sending non-essential data from the device, any software, not only cookies | ePrivacy Art. 5(3); Italy: Codice privacy art. 122; EDPB Guidelines 2/2023 | Yes |
| A random persistent `installId` is pseudonymous personal data | GDPR Recitals 26, 30 | Yes |
| Consent free, specific, informed, unambiguous; refusing as easy as accepting; withdrawing as easy as giving; the controller can demonstrate it | GDPR Art. 4(11), 7 | Yes |
| Information notice: controller and contact, purpose, legal basis, data, retention, recipients, transfers, rights, complaint to a supervisory authority | GDPR Art. 13 | Yes |
| Off until chosen | GDPR Art. 25 | Yes, already met |
| Access and erasure must be workable when the server knows only an `installId` | GDPR Art. 15, 17 | Yes |
| Record of processing; the under-250-staff exemption does not cover non-occasional processing | GDPR Art. 30 | Yes |
| Processor contract with whoever hosts the ingest server | GDPR Art. 28 | Yes, once hosted |
| No new consent request for 6 months after a refusal; refusing as easy as accepting | Digital Omnibus, Art. 88a in the Council text of June 2026 | *Provisional*: not law; the European Parliament has not voted. Treat as a design target |
| What is said must match what is done; using collected data more widely needs express consent; browsing data is treated as sensitive | FTC Act section 5; FTC v. Avast (2024) | Yes |
| Conspicuous privacy policy, including how Do Not Track is handled | CalOPPA | Probably not triggered by this payload alone; cheap to meet in the same notice |
| A browser offers a setting that sends an opt-out preference signal, from 2027-01-01 | California AB 566 (Opt Me Out Act) | *Provisional*: settled by checking whether the CCPA "business" thresholds bound it |
| CCPA/CPRA and other state privacy laws | Revenue and volume thresholds | No, thresholds not met; revisit at scale |
| EU Data Act; Cyber Resilience Act | Data Act covers connected products; CRA main duties start December 2027 | No; CRA later (data minimisation, Annex I) |

## Work

### PR A: telemetry consent and the privacy notice

1. **Privacy notice.** One notice for every data flow Orivon causes, not only telemetry, with
   the Art. 13 contents and a CalOPPA line on how Orivon handles DNT and GPC. English and
   Italian. Public in the repository, linked from the root `README.md`, and readable inside
   the product without network from the usage-statistics block in Settings. Controller and
   retention come from D1 and D2.
2. **Outbound-request inventory.** Enumerate every request the browser makes without the
   person asking for it: what leaves the device, to whom, when, and whether it can be turned
   off. Candidates to verify in code: update checks, Web3 Score provider fetches, IPFS and
   trustless-gateway fetches, the DoH resolver, filter-list and extension updates, telemetry.
   Each one goes in the notice. Any request that reveals which site the person is visiting
   goes to the owner before the notice ships.
3. **Consent record.** Store, with the choice, when it was made and which disclosure version
   was shown (local only, never sent). A material change to the payload or the disclosure
   text voids a stored acceptance and returns the state to `undecided`. Every release that
   can send telemetry is tagged, so the payload's `version` identifies the disclosure the
   sender saw.
4. **Withdrawal and erasure.** Turning off is one click, in the same place as turning on.
   After withdrawal nothing pending is sent. The "what has been sent" view shows the
   `installId`. The erasure path follows D3.
5. **No re-asking.** After "Turn off", no surface asks again for at least 6 months, tested.
   This also binds any first-run prompt D4 may bring back.
6. **Drift guard.** A test fails when the `TelemetryPayload` fields and the field list in the
   notice disagree, so the notice cannot fall behind the code (FTC section 5, Rule 17).
7. **Make the documents true** (Rule 3). Rewrite ADR-0004's title and Reasoning to match its
   Decision and D4, fix the "screens are not built" line in `src/telemetry/README.md`, add a
   decision-log row, and add a short telemetry statement to the root `README.md` (ADR-0004's
   announcement requirement).
8. **Compliance records.** An Art. 30 record of processing, and a short DPIA screening that
   says why a full DPIA is or is not needed. Either may be public.

### PR B: GPC at the level the Opt Me Out Act asks

A separate theme from PR A, so a separate PR.

1. When the setting is on, every page context reports `navigator.globalPrivacyControl ===
   true`, consistent with the header, in tabs, private windows and app views alike; check
   every session partition, not only the default one.
2. The default follows D5.
3. The Settings text says what the signal tells sites.
4. A decision-log row names AB 566 as the need.

It changes code that reaches pages, so the `orivon-qa` skill applies.

### Ingest server (outside this repository)

The endpoint in `runner.ts` is switched only when all of these hold, and release-checklist
item 1 (traffic watched) is run again afterwards:

- PR A is merged and D1 is answered.
- EU hosting, so there are no transfers out of the EU; the host's processor agreement
  (Art. 28) accepted by the owner.
- No IP address in any log; a fixed retention period (D2) with automatic deletion; erasure
  requests honoured (D3); the configuration published, as ADR-0004 promises.
- The notice reviewed by a privacy lawyer (owner action).

## Owner decisions

Ask them through the question tool, draft with the recommended default, and never wait idle
on them (Rule 13). Record each answer in the decision log.

- **D1. Controller.** A natural person or an entity, and the contact address for privacy
  requests. No default: draft with a placeholder; the endpoint switch waits on it.
- **D2. Retention.** Recommended: per-install rows for 12 months, then aggregates only.
- **D3. Erasure path.** Recommended: an in-product "delete my data" request that carries only
  the `installId`; it is a new message, so it amends ADR-0004. Alternative: a manual request
  by email quoting the `installId` shown in Settings.
- **D4. Where the choice is offered.** Recommended: confirm `d-0179` (Settings only), the
  later owner decision, and rewrite ADR-0004 to match. A first-run prompt measures more people
  and must obey item 5 of PR A.
- **D5. GPC default.** Recommended: on, for a browser whose thesis is privacy. Currently off.

## Out of scope

- A CCPA or state-law compliance programme (thresholds not met), COPPA (Orivon is not directed
  at children), the EU Data Act.
- Any widening of the payload; that is a new ADR and a new consent, per ADR-0004.

## Done when

- The notice is merged and reachable offline from Settings and from the README, and the
  inventory behind it is complete.
- Consent is versioned and timed; withdrawal and erasure work; the 6-month rule and the drift
  guard run in CI.
- ADR-0004, `d-0179` and `src/telemetry/README.md` agree.
- The GPC header and `navigator.globalPrivacyControl` agree in every context.
- D1 to D5 are answered or still carry their defaults, and the endpoint switch stays gated on
  the server conditions above.

## Sources

- GDPR (Regulation (EU) 2016/679); ePrivacy Directive 2002/58/EC; EDPB Guidelines 2/2023 on
  the technical scope of Art. 5(3) ePrivacy.
- Digital Omnibus, Art. 88a and 88b status:
  [Secure Privacy](https://secureprivacy.ai/blog/eu-digital-omnibus-what-article-88a-changes-for-cookie-consent-2026),
  [PPC Land](https://ppc.land/eu-council-drops-cookie-signal-after-google-lobbying-eur-40-50-bn-at-stake/),
  [GDPR Local](https://gdprlocal.com/cookie-banner-reform/).
- California Opt Me Out Act:
  [California Privacy Protection Agency](https://privacy.ca.gov/2026/01/californias-opt-me-out-act-your-privacy-just-got-easier),
  [Jones Day](https://www.jonesday.com/de/insights/2025/10/california-enacts-trio-of-new-consumer-privacy-obligations).
- FTC v. Avast (2024); California Online Privacy Protection Act (Bus. & Prof. Code section 22575).
