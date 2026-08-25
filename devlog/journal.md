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

## Week of 2026-08-24

### Done / results
- 2026-08-25: Set up the weekly devlog system (journal capture + /devlog compiler + Sunday cron draft).
- 2026-08-25: **Owner gave the go.** Preparation phase closed (A6); the week-0 spike is next.
- 2026-08-25: Two one-way doors decided — cached apps keep their real origin (ADR-0007), and capability handles are WHATWG streams underneath with Node shapes on top (A10 direction; full spec still to write).
- 2026-08-25: Week-0 spike execution plan written, gate by gate, with the throwaway/kept code line drawn explicitly.
- 2026-08-25: Live API check corrected four things the docs got wrong: webtorrent is 3.0.21 not 2.x, its `browser` field disables more than recorded, `createServer` has an Electron-specific `force` flag, and electron#34905 is still open — the last one added a new gate 0 to the spike.

### In my head
- 2026-08-25: Wants a Sunday ritual: paste-ready team message plus bullet cues for a spontaneous voice note recalling the week's thinking.
- 2026-08-25: Keen to start building the browser; kept checking whether preparation was really finished. Accepted that the spike comes first once it was clear a spike failure would invalidate a week of shell work.
- 2026-08-25: Thinking about model cost discipline — wants to know when Opus is genuinely needed versus when Sonnet is enough.

### Non-repo
