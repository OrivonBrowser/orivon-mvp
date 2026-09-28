---
name: block-electron-launch-that-can-show-a-window
enabled: true
event: bash
pattern: (?!.*scripts/run-headless\.mjs)(?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+)?(?:[\w./-]*/)?(electron\b|electron-vite\s+(?:dev|preview)|npm\s+run\s+(?:dev|start)\b)
action: block
---

**Electron launch blocked: it can put a window on the owner's real desktop.**

Never open a window on the owner's screen or take focus from them. Every Electron launch goes
through `node scripts/run-headless.mjs <command>`, which uses a virtual display.
`ORIVON_WINDOW_NO_FOCUS=1` (the default in `test/launch-electron.mjs`) only stops focus theft; a
window still appears without the virtual display. Use instead:

- `npm run smoke` / `npm run test:e2e`: already wrapped.
- Anything ad hoc: `node scripts/run-headless.mjs node <your-script>.mjs`.

**`npm run dev` and `electron-vite dev` are the owner's to start, never an agent's.** To see a
change in the running app, ask the owner to restart their dev server. Do not add `--watch` to
`scripts/dev.mjs`: it relaunches the window on every `src/main/` or `src/preload/` edit. If a
launch must be visible, ask the owner first.
