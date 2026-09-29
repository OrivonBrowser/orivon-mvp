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

## Week of 2026-09-28

### Done / results

- Web3 Score shield back to its outline, coloured by level; a Web2/Web2.5/Web3 mark replaces the Orivon logo in the address bar.
- In dev mode, a local origin serving a DDOC tree shows Level 2, and the Web3 Score page says it counts only in dev mode.
- Direction set: this is Orivon Browser, not an MVP. Electron base, TypeScript, features land one at a time as needs arise.
- Apps can show a website inside their own page: `<webview>` under a `web.embed` grant, with the app's script running first in every shown page.
- A manifest can ask for cross-origin isolation, so a WebAssembly component built with threads gets `SharedArrayBuffer`.
- Review of three merged PRs found five HIGH regressions; all fixed, with `.eth` gateways, favicons and the chrome lock hardened.

- Settings page at orivon://settings: a section per implemented feature, searchable, live-applied, remappable shortcuts, per-site zoom, local history, F12 on any tab.
- Tabs reorder, tear off and move between windows; two tabs split side by side or stacked, with a divider and edge-drag to make one.
- Profiles and private windows are separate processes: a second start of a profile hands over; a private session's directory is deleted when it ends.
- Two hostile reviews of that work found about twenty defects, from a leaked listener to history that could end the browser; all fixed with tests.
- Tearing off a tab now previews where its window opens; Settings and History restyled; eight shell bugs from daily use fixed.
- Volume Master works; link middle-clicks no longer crash; no white flashes; Settings updates live; extension popups close. Google sign-in still refused.

### In my head

### Non-repo
