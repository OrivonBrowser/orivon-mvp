---
name: block-electron-launch-outside-headless-runner
enabled: true
event: bash
action: block
conditions:
  - field: command
    operator: regex_match
    pattern: (?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*(?:npx\s+)?(?:\./)?(?:node_modules/\.bin/)?electron(?:\s|$)|electron/dist/electron|_electron\.launch|npm\s+run\s+(?:start|dev)(?:\s|$)
---

**An Electron launch must go through `scripts/run-headless.mjs` — blocked otherwise.**

**Why this is a block and not a warning.** The owner works on this machine while agents run. A
launch that reaches the real desktop opens a window **in front of whatever they are typing into**,
steals focus, and — when a run dies badly — leaves an orphaned tree and a modal error dialog that
keeps its process alive forever. That is owner directive `D-0002`, and it was raised again on
2026-09-15 when an e2e stole focus mid-typing.

**`xvfb-run` alone does NOT prevent this, which is the trap that made the rule necessary.** This
is a Wayland desktop. `xvfb-run` starts an X server and sets `DISPLAY`, but Electron's ozone layer
auto-detects, finds `WAYLAND_DISPLAY` still inherited from the session, and connects to the **real
compositor** — the window opens on the owner's actual screen while the log cheerfully reports
"using a virtual display". `scripts/run-headless.mjs` is the one place that strips `WAYLAND_DISPLAY`
so X11 (the virtual one) is all ozone can find.

**Use instead:**

    env -u ELECTRON_RUN_AS_NODE npm run test:e2e     # or: npm run smoke

Both route through the headless runner. `ELECTRON_RUN_AS_NODE=1` is set in this machine's ambient
shell and turns the Electron binary into plain Node — windowless, `MessagePortMain` absent, and it
**fails silently**, so strip it explicitly every time.

**If you genuinely need a one-off launch** (a throwaway probe app), wrap it the same way:

    env -u ELECTRON_RUN_AS_NODE node scripts/run-headless.mjs npx electron /path/to/probe

and check `pgrep -f node_modules/electron/dist/electron` is empty afterwards. A run that leaves a
process behind is not a finished run. See `.claude/skills/orivon-electron/SKILL.md`.
