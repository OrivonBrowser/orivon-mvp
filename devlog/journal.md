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

## Week of 2026-10-05

### Done / results

- Wayland tab drags are now the browser's own drag and drop: the drag image follows outside the window and the other window marks the slot.
- A catalogue of what apps rely on now has a test per row; a broker change that breaks an app fails by name.
- test/ is grouped into areas, and a new capability, port or app bug has one README saying a row and a spec are required.
- All six Orivon apps are on IPFS, listed in Explore, and judged by Orivon Attila, our official Web3 Score provider.
- An ipfs:// tab icon now waits out slow gateways instead of giving up at 5 s, the likely reason The Lounge showed none.
- Every ported app now shows visitors in other browsers a panel pointing them to Orivon; it stays hidden inside Orivon, and --no-orivon-hint removes it.
- Orivon asks to be the default browser from Settings, the welcome screen and weekly; the dock and taskbar offer New Window and New Private Window.
- CI's e2e now runs only the specs a change can reach, in parallel shards: minutes instead of forty.
- The shell's own pages no longer load from `file:`, and Electron's file-protocol fuse is off in every binary: local files can ship without extra privileges.

### In my head

### Non-repo
