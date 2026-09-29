import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `npm start` must never run a bare `electron-vite preview`: `preview` alone
 * rebuilds with whatever the calling shell's environment happens to be
 * (electron-vite's own `preview()`, node_modules/electron-vite/dist/chunks/
 * lib-Dvh2Hokw.js, calls `build()` unless `skipBuild` is set), and
 * electron.vite.config.ts trusts `process.env.ORIVON_ENABLE_DEV_GRANT`
 * exactly as it finds it. A leftover export from an earlier
 * `npm run test:e2e` in the same shell would then compile the developer-only
 * grant path into what a run-from-source user launches.
 *
 * `scripts/build-ordinary.mjs` is what strips that variable before building
 * (its own header, and scripts/check-dev-grant-absent.mjs's regression
 * coverage) -- `npm start` must run it first, and then skip `preview`'s own
 * build with `--skipBuild` so that build is the one Electron launches.
 */
describe('npm start builds ordinarily before it previews', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const start = pkg.scripts.start

  it('runs scripts/build-ordinary.mjs', () => {
    expect(start).toContain('scripts/build-ordinary.mjs')
  })

  it('previews with --skipBuild, so preview cannot rebuild from the ambient env', () => {
    expect(start).toMatch(/electron-vite preview\b.*--skipBuild/)
  })
})
