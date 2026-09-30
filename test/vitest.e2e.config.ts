import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The e2e suites launch a real Electron binary, so vitest.config.ts's
// `include` keeps them out of the unit suite. `vitest run <path>` does not
// bypass `include`, so selecting them takes this second config. `test/apps/**`
// is excluded: those are the apps the suites serve, not suites.
//
// Run with: npx vitest run --config test/vitest.e2e.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist', 'spike/**', 'test/apps/**'],
    // The default reporter swallows a passing test's console.log, and a run
    // must report what it observed without anyone passing a flag.
    reporters: ['verbose'],
    // Serial: every suite binds the same fixed fixture ports
    // (test/apps/fixture/config.mjs) and launches Electron, so two at once
    // fail to bind STATIC_PORT and fail electron.launch() with ETXTBSY.
    // Separate port ranges would not fix it: concurrent launches still race.
    fileParallelism: false,
    // Failure evidence for every spec; see test/qa-evidence.mjs.
    globalSetup: ['test/qa-global-setup.ts'],
    setupFiles: ['test/qa-setup.ts']
  }
})
