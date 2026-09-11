import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every `check:*` script in package.json must be invoked somewhere in
 * .github/workflows/ci.yml -- a guard nobody runs protects nothing. This
 * lane (F4) exists because check:dev-grant-absent was exactly that: written,
 * passing by hand, and never wired in. See
 * docs/planning/unattended-build-queue.md item 0.3.
 *
 * Deliberately a vitest test, not an eighth check:* script: `npm test` is
 * already unconditional in ci.yml's `check` job, so this guard cannot itself
 * become the bug it exists to catch. A `check:*` script has no such
 * guarantee -- it still has to be added to ci.yml by hand, which is the
 * whole failure mode.
 */
describe('every check:* script is wired into CI', () => {
  const root = process.cwd()
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const ciYml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')

  const checkScripts = Object.keys(pkg.scripts).filter((name) => name.startsWith('check:'))

  // If package.json's naming convention ever moves away from a `check:`
  // prefix, this test must not go on passing having quietly checked nothing.
  it('found at least one check:* script to verify', () => {
    expect(checkScripts.length).toBeGreaterThan(0)
  })

  it.each(checkScripts)('%s is run somewhere in ci.yml', (name) => {
    expect(ciYml).toContain(`npm run ${name}`)
  })
})
