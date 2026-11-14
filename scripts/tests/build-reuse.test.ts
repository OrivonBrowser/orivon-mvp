import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEY_FILE, REQUIRED_OUTPUTS, buildOrReuse } from '../build-reuse.mjs'
import { GRANT_ENV, inputsRepo, write } from './build-key.test-helpers.js'

/** A build that writes the outputs a finished one leaves and counts how often it ran. */
function fakeBuilds (root: string, effect: () => number = () => 0) {
  const state = { runs: 0, lines: [] as string[] }
  const build = (): number => {
    state.runs += 1
    const status = effect()
    if (status === 0) for (const path of REQUIRED_OUTPUTS) write(root, path, `build ${String(state.runs)}\n`)
    return status
  }
  const go = (kind: 'e2e' | 'ordinary' = 'e2e', env: NodeJS.ProcessEnv = kind === 'e2e' ? GRANT_ENV : {}): number =>
    buildOrReuse({ root, kind, env, build, log: (line) => state.lines.push(line) })
  return { state, go }
}

describe('buildOrReuse', { timeout: 30_000 }, () => {
  it('builds once, then reuses the build while no input changes, and says so', () => {
    const root = inputsRepo()
    const { state, go } = fakeBuilds(root)
    expect(go()).toBe(0)
    expect(state.runs).toBe(1)
    expect(existsSync(join(root, KEY_FILE))).toBe(true)
    expect(go()).toBe(0)
    expect(go()).toBe(0)
    expect(state.runs).toBe(1)
    expect(state.lines).toHaveLength(2)
    expect(state.lines[0]).toMatch(/^Reusing out\/.*e2e build.*ORIVON_FORCE_BUILD=1/)
  })

  it('builds again after a source edit or a new source file, and reuses after a change under test/ alone', () => {
    const root = inputsRepo()
    const { state, go } = fakeBuilds(root)
    go()
    write(root, 'test/spec.test.ts', 'export const t = 1\n')
    go()
    expect(state.runs).toBe(1)
    write(root, 'src/main/index.ts', 'export const a = 2\n')
    go()
    expect(state.runs).toBe(2)
    go()
    expect(state.runs).toBe(2)
    write(root, 'src/main/added.ts', 'export {}\n')
    go()
    expect(state.runs).toBe(3)
  })

  it('never reuses an e2e build for an ordinary one, nor an ordinary build for an e2e one', () => {
    const root = inputsRepo()
    const { state, go } = fakeBuilds(root)
    go('e2e')
    go('ordinary')
    expect(state.runs).toBe(2)
    go('ordinary')
    expect(state.runs).toBe(2)
    go('e2e')
    expect(state.runs).toBe(3)
  })

  it('builds when ORIVON_FORCE_BUILD=1, and the forced build is reusable afterwards', () => {
    const root = inputsRepo()
    const { state, go } = fakeBuilds(root)
    go()
    go('e2e', { ...GRANT_ENV, ORIVON_FORCE_BUILD: '1' })
    expect(state.runs).toBe(2)
    go()
    expect(state.runs).toBe(2)
  })

  it('leaves no matching key behind a failed build, and none behind a build that threw', () => {
    const root = inputsRepo()
    let failing = false
    let throwing = false
    const { state, go } = fakeBuilds(root, () => {
      if (throwing) throw new Error('interrupted')
      return failing ? 1 : 0
    })
    go()
    expect(existsSync(join(root, KEY_FILE))).toBe(true)
    write(root, 'src/main/index.ts', 'export const a = 2\n')
    failing = true
    expect(go()).toBe(1)
    expect(existsSync(join(root, KEY_FILE))).toBe(false)
    failing = false
    throwing = true
    write(root, 'src/main/index.ts', 'export const a = 3\n')
    expect(() => go()).toThrow('interrupted')
    expect(existsSync(join(root, KEY_FILE))).toBe(false)
    throwing = false
    go()
    expect(state.runs).toBe(4)
  })

  it('records nothing when an input changed while the build ran', () => {
    const root = inputsRepo()
    const { state, go } = fakeBuilds(root, () => {
      write(root, 'src/main/index.ts', 'export const a = 9\n')
      return 0
    })
    go()
    expect(existsSync(join(root, KEY_FILE))).toBe(false)
    expect(state.lines.join('\n')).toMatch(/changed while the build ran/)
  })

  it('builds when an output is missing, rewritten or removed after the build', () => {
    const root = inputsRepo()
    const { state, go } = fakeBuilds(root)
    go()
    write(root, 'out/renderer/extra.js', 'x\n')
    go()
    expect(state.runs).toBe(2)
    write(root, 'out/main/index.js', 'a dev server wrote this\n')
    go()
    expect(state.runs).toBe(3)
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(join(root, 'out/preload/app.js'), old, old)
    go()
    expect(state.runs).toBe(4)
    rmSync(join(root, 'out/renderer/index.html'))
    go()
    expect(state.runs).toBe(5)
    go()
    expect(state.runs).toBe(5)
  })

  it('builds when the key file is damaged', () => {
    const root = inputsRepo()
    const { state, go } = fakeBuilds(root)
    go()
    writeFileSync(join(root, KEY_FILE), '{"key":')
    go()
    expect(state.runs).toBe(2)
    expect(JSON.parse(readFileSync(join(root, KEY_FILE), 'utf8')).key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('always builds outside a git checkout, and records no key', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-build-reuse-nogit-'))
    const { state, go } = fakeBuilds(root)
    go()
    go()
    expect(state.runs).toBe(2)
    expect(existsSync(join(root, KEY_FILE))).toBe(false)
  })
})
