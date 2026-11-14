# The week-0 spike: where the evidence is kept

Most of the Electron and webtorrent behaviour in this skill was measured by the week-0 spike. `spike/` is historical
evidence, kept as it was measured (`spike/README.md`): never import from it, modernise it or fix its lint.

Gates 0, 1a, 1b and 2 pass; gate 3 (video playback) is blocked on a Playwright attach failure
(`playwright-electron.md`), not on the app; gate 4 measured 52 MB/s shimmed, which fails its literal
relative-to-control threshold and beats the product requirement tenfold.

- `docs/planning/spike-verdict.md`: the readable summary; start there.
- `docs/planning/spike-results/gate-{0,1a,1b,2,3,4}.json`: raw measured evidence.
- `docs/planning/week-0-spike-plan.md` (superseded) and `spike-remaining-gates-plan.md`: the execution plans, with
  their state tables and traps lists.
- `spike/launch.mjs`, `spike/gate1b/vite.config.js`, `spike/gate1b/shim/*.js`: the reference implementations.
  `test/support/launch-electron.mjs` is the live descendant of `spike/launch.mjs`.
- `docs/architecture/capability-api.md` sections Design rules and Throughput, and
  `docs/architecture/handle-contracts.md` section What the shim must do: where the durable lessons (shim
  completeness, error visibility, transferables) are folded into the actual spec.
- The window fixes the spike led to live in `src/main/shell/window-frame.ts` (`showOnce`) and
  `src/main/shell/window-size-settle.ts` (`relayoutOnSizeChange`), described in `window-and-views.md`.
