# Devlog journal — running capture

This file is the raw material for the Sunday devlog. It is append-only during the
week and compiled by `/devlog` into `devlog/updates/YYYY-MM-DD.md`, after which the
compiled week is cleared and a fresh week heading is started.

Three buckets per week:

- **Done / results** — technical outcomes worth telling the team. One line each.
- **In my head** — what the owner has been thinking about: doubts, direction changes,
  things circling that are not visible in commits. These become the voice-note cues.
- **Non-repo** — calls, Notion work, admin, anything outside this repository. Claude
  cannot see these, so the owner jots them here (or they get a placeholder on Sunday).

Mark anything that must not leave the team draft as `(Keep private)`.

---

## Week of 2026-10-19

### Done / results

- An install whose checkpoint has aged out now fetches a fresh one from two beacon servers and uses it only if they agree.
- The opt-in usage report now names the app a tagged installer opened on first run; the notice re-asks.
- The update check now sees pre-releases; a bot refreshes the bundled checkpoint twice a week, and a release refuses one over seven days old.
- `orivon:` links open a .eth name or IPFS address from other programs; an installer named for an app opens that app on first run.
- The new tab gained hideable Featured tiles, a Your apps row and a dismissible Start here card; the first permission question now says why.
- Releases submit themselves to the Microsoft Store, AUR and winget once credentials exist, with notes and a What's new page from the changelog.
- Every port was republished: ASGARDEX 1.46.1, Element 1.12.32, AirGap Vault 3.35.0, a landing outside Orivon, LICENSE files and build provenance.
- Ports gained an upstream-release watcher, attested builds and `orivon-port verify`, which rebuilds a published app and compares its bundle.
- CI now catches two branches that took the same ADR or decision number, and pr-watch settles decision-log conflicts by itself.
- Windows gets a one-line PowerShell install with no SmartScreen warning, and the Microsoft Store joins each release's file table.
- Private live telemetry dashboard on our server; telemetry now keeps each install's usage day by day, and the privacy notice says so.

### In my head

### Non-repo
