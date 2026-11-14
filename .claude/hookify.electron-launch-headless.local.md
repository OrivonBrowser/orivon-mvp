---
name: block-electron-launch-outside-headless-runner
enabled: true
event: bash
action: block
pattern: (?!.*scripts/run-headless\.mjs)(?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+)?(?:[\w./-]*/)?(?:electron\b|electron-vite\s+(?:dev|preview)|npm\s+run\s+(?:dev|start)\b)|(?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+)?(?:\./)?(?:node_modules/\.bin/)?electron(?:\s|$)|electron/dist/electron|_electron\.launch|npm\s+run\s+(?:start|dev)(?:\s|$)
---

**An Electron launch must go through `scripts/run-headless.mjs`; this one does not.**

Any other launch can open a window on the owner's real screen and take focus. `xvfb-run` alone does
not prevent it: Electron finds the inherited `WAYLAND_DISPLAY` and opens on the real compositor, and
`scripts/run-headless.mjs` strips it. `ORIVON_WINDOW_NO_FOCUS=1` (the default in
`test/support/launch-electron.mjs`) only stops focus theft: a window still appears without the virtual
display. The ambient `ELECTRON_RUN_AS_NODE=1` silently turns Electron into plain Node, so strip that too.

`npm run dev`, `npm run start` and `electron-vite dev` are the owner's to start, never an agent's:
to see a change in the running app, ask the owner to restart their dev server, and ask first if a
launch must be visible. Do not add `--watch` to `scripts/dev.mjs`: it relaunches the window on every
`src/main/` or `src/preload/` edit. Use instead:

    env -u ELECTRON_RUN_AS_NODE npm run test:e2e     # or: npm run smoke; both are already wrapped
    env -u ELECTRON_RUN_AS_NODE node scripts/run-headless.mjs npx electron /path/to/probe
    env -u ELECTRON_RUN_AS_NODE node scripts/run-headless.mjs node <your-script>.mjs

A run that leaves an Electron process behind is not finished. The survivor check, and why a bare
`pgrep -f` misleads, are in `.claude/skills/orivon-electron/references/headless-launch.md`.
