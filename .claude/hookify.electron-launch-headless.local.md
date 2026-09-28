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

**An Electron launch must go through `scripts/run-headless.mjs`; this one does not.**

Any other launch can open a window on the owner's real screen and take focus. `xvfb-run` alone
does not prevent it on this Wayland desktop: Electron finds the inherited `WAYLAND_DISPLAY` and
opens on the real compositor, and `scripts/run-headless.mjs` is what strips it. The ambient
`ELECTRON_RUN_AS_NODE=1` silently turns Electron into plain Node, so strip that too. `npm run dev`
and `npm run start` are the owner's to run, never an agent's. Use instead:

    env -u ELECTRON_RUN_AS_NODE npm run test:e2e     # or: npm run smoke
    env -u ELECTRON_RUN_AS_NODE node scripts/run-headless.mjs npx electron /path/to/probe

A run that leaves an Electron process behind is not finished. The survivor check, and why a bare
`pgrep -f` misleads, are in `.claude/skills/orivon-electron/SKILL.md`.
