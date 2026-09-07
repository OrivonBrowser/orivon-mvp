import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// vitest.config.ts's own `include` is `src/**/*.test.ts` / `scripts/**/*.test.ts`
// (docs/development/testing.md, "picks up src/**/*.test.ts and
// scripts/**/*.test.ts") -- test/ is neither, and that file is root-owned,
// not this lane's to edit (docs/development/parallel-work.md: stay inside
// owned paths). Confirmed empirically (vitest 4.1.11): unlike an older
// assumption recorded in apps/fixture/README.md ("Run directly with `npx
// vitest run apps/fixture/manifest.test.ts`"), an explicit path argument
// does NOT bypass `include` in this version -- `vitest run <path>` still
// reports "No test files found" against a path the include globs do not
// cover. This file is exactly the escape hatch that same README names:
// "or use whatever mechanism the owner decides on... a temporary config
// pointing include at apps/fixture/**/*.test.ts". Scoped to test/**/*.test.ts
// specifically (not apps/fixture/**, which is a separate, narrower unit
// test with its own already-working situation) because this file exists
// for THIS lane's own e2e test.
//
// Run with: npx vitest run --config test/vitest.e2e.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist', 'spike/**'],
    // Vitest's default reporter swallows a passing test's console.log --
    // confirmed empirically, the report only appeared with `--reporter
    // verbose` on the command line. This test's whole point (acceptance
    // criterion 4, matching scripts/smoke.mjs's own stated property) is
    // that it reports what happened without anyone having to remember a
    // flag, so 'verbose' is set here rather than documented as a thing to
    // pass.
    reporters: ['verbose'],
    // THE E2E SUITES CANNOT RUN CONCURRENTLY, and vitest's default is that
    // they do. Each one spawns its own fixture servers on FIXED ports
    // (apps/fixture/config.mjs) and launches a real Electron binary; two
    // files doing that at once collide three ways, all of them observed on
    // CI in one run: the second `serve.mjs` cannot bind STATIC_PORT, the
    // first suite's own fetch of the fixture manifest then fails, and the
    // two simultaneous `electron.launch()` calls fail with `spawn ETXTBSY`.
    //
    // It passed locally and failed on CI, which is exactly the shape of a
    // scheduling race -- the ports and the binary are shared whatever the
    // machine, only the interleaving differs. Serialising is the fix rather
    // than assigning each suite its own port range: two Electron launches at
    // once would still be a race, and an e2e that drives a real GUI has no
    // business running in parallel with another one anyway.
    fileParallelism: false
  }
})
