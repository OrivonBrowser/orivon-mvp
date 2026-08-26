import { defineConfig } from 'vitest/config'

// Node environment only. The MVP's unit tests cover security-critical pure
// functions -- capability checks, path traversal, origin derivation, key
// derivation, the update decision table, telemetry accounting (build-plan.md
// SS Testing). None of those need a DOM, and no UI tests are planned.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist', 'spike/**']
  }
})
