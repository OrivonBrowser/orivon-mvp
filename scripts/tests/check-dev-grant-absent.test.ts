import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDevGrantAbsent, DEV_GRANT_MARKER } from '../check-dev-grant-absent.mjs'

/** A scratch directory standing in for a repository root; `build` never actually runs electron-vite. */
function withOutput (files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'orivon-dev-grant-'))
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

describe('checkDevGrantAbsent', () => {
  it('passes when the compiled output never mentions the dev-grant marker', () => {
    const root = withOutput({ 'out/main/index.js': 'const devGrantSubsystem = { afterReady: () => { return } };\n' })
    const result = checkDevGrantAbsent(root, { build: () => {} })
    expect(result.ok).toBe(true)
    expect(result.offenders).toEqual([])
  })

  // The regression this file exists to prevent a SECOND time. The guard used to
  // build first and scan only afterwards, so it always inspected an artefact it
  // had just made ordinarily -- it could not fail, whatever was in out/. A real
  // `npm run test:e2e` leaves a dev-enabled bundle there, and the guard called
  // it clean.
  it('fails on a dev-enabled artefact already in out/, even when the build it runs is clean', () => {
    const root = withOutput({
      'out/main/index.js': `globalThis.${DEV_GRANT_MARKER} = async () => {};\n`
    })
    // A build that leaves the dev-enabled file exactly as it found it stands in
    // for an ordinary build that writes elsewhere, or one already up to date.
    const result = checkDevGrantAbsent(root, { build: () => {} })

    expect(result.ok).toBe(false)
    expect(result.preExisting).toEqual(['out/main/index.js'])
  })

  it('does not double-report a file that both the pre-existing scan and the rebuild flag', () => {
    const root = withOutput({
      'out/main/index.js': `globalThis.${DEV_GRANT_MARKER} = async () => {};\n`
    })
    const result = checkDevGrantAbsent(root, {
      build: () => { writeFileSync(join(root, 'out/main/index.js'), `globalThis.${DEV_GRANT_MARKER} = async () => {};\n`) }
    })

    expect(result.offenders).toEqual(['out/main/index.js'])
  })

  it('fails when the marker survived into main output -- the exact regression this guards against', () => {
    const root = withOutput({
      'out/main/index.js': `globalThis.${DEV_GRANT_MARKER} = async () => {};\n`
    })
    const result = checkDevGrantAbsent(root, { build: () => {} })
    expect(result.ok).toBe(false)
    expect(result.offenders).toEqual(['out/main/index.js'])
  })

  it('scans every .js file under the output directory, not only main/index.js', () => {
    const root = withOutput({
      'out/main/index.js': 'fine\n',
      'out/preload/app.js': `const x = "${DEV_GRANT_MARKER}"\n`
    })
    const result = checkDevGrantAbsent(root, { build: () => {} })
    expect(result.offenders).toEqual(['out/preload/app.js'])
  })

  it('ignores non-JS files even if they happen to contain the marker text', () => {
    const root = withOutput({
      'out/main/index.js.map': `{"sourcesContent":["... ${DEV_GRANT_MARKER} ..."]}`,
      'out/main/index.js': 'fine\n'
    })
    const result = checkDevGrantAbsent(root, { build: () => {} })
    expect(result.ok).toBe(true)
  })

  it('is a pass, not a crash, when the output directory does not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-dev-grant-empty-'))
    const result = checkDevGrantAbsent(root, { build: () => {} })
    expect(result.ok).toBe(true)
    expect(result.offenders).toEqual([])
  })

  it('runs the given build before scanning, so a build that writes output after being called still gets checked', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-dev-grant-late-'))
    const build = (): void => {
      mkdirSync(join(root, 'out', 'main'), { recursive: true })
      writeFileSync(join(root, 'out', 'main', 'index.js'), `${DEV_GRANT_MARKER}\n`)
    }
    expect(checkDevGrantAbsent(root, { build }).ok).toBe(false)
  })
})
