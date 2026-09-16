---
name: block-electron-launch-that-can-show-a-window
enabled: true
event: bash
pattern: (?!.*scripts/run-headless\.mjs)(?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+)?(?:[\w./-]*/)?(electron\b|electron-vite\s+(?:dev|preview)|npm\s+run\s+(?:dev|start)\b)
action: block
---

**Electron launch blocked: it can put a window on the owner's real desktop.**

Owner, 2026-09-15, after this happened repeatedly in one session and was called out three
times: **never open a window in focus, and never interrupt the owner's work with one.**

Every Electron launch this repository makes must go through
`node scripts/run-headless.mjs <command>`, which runs it under `xvfb-run` — a virtual
display, nothing on screen at all. `test/launch-electron.mjs` additionally defaults
`ORIVON_WINDOW_NO_FOCUS=1`, which makes `window.ts` call `showInactive()` instead of
`show()`, but **that only stops the keyboard being stolen — it does not stop a window
appearing.** The virtual display is what does.

Use instead:

- `npm run smoke` / `npm run test:e2e` — already wrapped, safe.
- Anything ad hoc: `node scripts/run-headless.mjs node <your-script>.mjs`.

**`npm run dev` and `electron-vite dev` are the owner's to start, never an agent's.** If you
need to see a change in the running app, ask the owner to restart their own dev server; do not
start one. Related, and the reason this rule exists at all: `electron-vite dev --watch`
restarts the whole app on every `src/main/` or `src/preload/` edit, so an agent editing
main-process files while a dev server runs repeatedly pops the window back onto the owner's
screen. `scripts/dev.mjs` deliberately does not pass `--watch` — do not add it back.

If a launch genuinely must be visible, stop and ask the owner first.
