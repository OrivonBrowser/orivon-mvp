import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CACHE_DIR, KEY_FILE, REQUIRED_OUTPUTS, buildOrReuse } from '../build-reuse.mjs'
import { GRANT_ENV, inputsRepo, write } from './build-key.test-helpers.js'

type Kind = 'e2e' | 'ordinary'

/** A build that writes the outputs a finished one leaves, naming the kind and the run, and counts how often it ran. */
function fakeBuilds (root: string, effect: () => number = () => 0) {
  const state = { runs: 0, lines: [] as string[], kind: 'e2e' as Kind }
  const build = (): number => {
    state.runs += 1
    const status = effect()
    if (status === 0) for (const path of REQUIRED_OUTPUTS) write(root, path, `${state.kind} build ${String(state.runs)}\n`)
    return status
  }
  const go = (kind: Kind = 'e2e', env: NodeJS.ProcessEnv = kind === 'e2e' ? GRANT_ENV : {}): number => {
    state.kind = kind
    return buildOrReuse({ root, kind, env, build, log: (line) => state.lines.push(line) })
  }
  /** The run that wrote what out/ holds now, as `<kind> build <run>`. */
  const held = (): string => readFileSync(join(root, 'out/main/index.js'), 'utf8').trim()
  return { state, go, held }
}

/** Where the build of `kind` waits while the other kind is in out/. */
const slot = (root: string, kind: Kind): string => join(root, CACHE_DIR, kind)

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

  it('never hands an e2e build to an ordinary build, nor an ordinary build to an e2e one', () => {
    const root = inputsRepo()
    const { state, go, held } = fakeBuilds(root)
    go('e2e')
    expect(held()).toBe('e2e build 1')
    go('ordinary')
    expect(held()).toBe('ordinary build 2')
    expect(state.runs).toBe(2)
    go('ordinary')
    expect(state.runs).toBe(2)
    expect(held()).toBe('ordinary build 2')
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

describe('buildOrReuse across the two build kinds', { timeout: 30_000 }, () => {
  it('reuses on the third build of an e2e, ordinary, e2e run, and on every one after', () => {
    const root = inputsRepo()
    const { state, go, held } = fakeBuilds(root)
    go('e2e')
    go('ordinary')
    expect(state.runs).toBe(2)
    expect(state.lines).toEqual([expect.stringMatching(/^Parked the e2e build of out\/ in \.cache\/build\/e2e\/\.$/)])
    go('e2e')
    expect(state.runs).toBe(2)
    expect(held()).toBe('e2e build 1')
    expect(state.lines.at(-1)).toMatch(/^Reusing out\/ \(moved back from \.cache\/build\/e2e\/\): .*e2e build.*ORIVON_FORCE_BUILD=1/)
    for (const kind of ['ordinary', 'e2e', 'ordinary', 'e2e'] as const) {
      go(kind)
      expect(held()).toBe(kind === 'e2e' ? 'e2e build 1' : 'ordinary build 2')
    }
    expect(state.runs).toBe(2)
  })

  it('keeps one build per kind: the other kind parked and the current one in out/', () => {
    const root = inputsRepo()
    const { go } = fakeBuilds(root)
    go('e2e')
    expect(existsSync(slot(root, 'e2e'))).toBe(false)
    expect(existsSync(slot(root, 'ordinary'))).toBe(false)
    go('ordinary')
    expect(existsSync(slot(root, 'e2e'))).toBe(true)
    expect(existsSync(slot(root, 'ordinary'))).toBe(false)
    go('e2e')
    expect(existsSync(slot(root, 'e2e'))).toBe(false)
    expect(existsSync(slot(root, 'ordinary'))).toBe(true)
  })

  it('reuses after an edit that only touches unit tests, and builds both kinds again after a source edit', () => {
    const root = inputsRepo()
    const { state, go, held } = fakeBuilds(root)
    go('e2e')
    go('ordinary')
    write(root, 'src/main/tests/omnibox.test.ts', 'export const t = 1\n')
    write(root, 'src/shim/__tests__/helper.ts', 'export const h = 1\n')
    go('e2e')
    go('ordinary')
    expect(state.runs).toBe(2)
    write(root, 'src/main/index.ts', 'export const a = 2\n')
    go('e2e')
    expect(state.runs).toBe(3)
    expect(held()).toBe('e2e build 3')
    go('ordinary')
    expect(state.runs).toBe(4)
    go('e2e')
    go('ordinary')
    expect(state.runs).toBe(4)
  })

  it('never reuses a parked build whose inputs changed, and drops it', () => {
    const root = inputsRepo()
    const { state, go, held } = fakeBuilds(root)
    go('e2e')
    go('ordinary')
    write(root, 'src/main/index.ts', 'export const a = 2\n')
    go('e2e')
    expect(state.runs).toBe(3)
    expect(held()).toBe('e2e build 3')
    expect(existsSync(slot(root, 'e2e'))).toBe(false)
    expect(existsSync(slot(root, 'ordinary'))).toBe(false)
  })

  it('keeps the parked build of its kind through a build that fails, for the inputs it was built from', () => {
    const root = inputsRepo()
    let failing = false
    const { state, go, held } = fakeBuilds(root, () => (failing ? 1 : 0))
    go('e2e')
    go('ordinary')
    write(root, 'src/main/index.ts', 'export const a = 2\n')
    failing = true
    expect(go('e2e')).toBe(1)
    expect(existsSync(slot(root, 'e2e'))).toBe(true)
    write(root, 'src/main/index.ts', 'export const a = 1\n')
    failing = false
    go('e2e')
    expect(state.runs).toBe(3)
    expect(held()).toBe('e2e build 1')
  })

  it('never parks a build whose inputs changed', () => {
    const root = inputsRepo()
    const { state, go } = fakeBuilds(root)
    go('e2e')
    go('ordinary')
    go('e2e')
    write(root, 'src/main/index.ts', 'export const a = 2\n')
    go('ordinary')
    expect(state.runs).toBe(3)
    expect(existsSync(slot(root, 'e2e'))).toBe(false)
    expect(state.lines.filter((line) => line.startsWith('Parked'))).toHaveLength(2)
  })

  it('never reuses a parked build that was written to, shortened or hand-moved into the other slot', () => {
    const root = inputsRepo()
    const { state, go, held } = fakeBuilds(root)
    go('e2e')
    go('ordinary')
    write(root, `${CACHE_DIR}/e2e/main/index.js`, 'a dev server wrote this\n')
    go('e2e')
    expect(state.runs).toBe(3)
    expect(held()).toBe('e2e build 3')

    go('ordinary')
    expect(state.runs).toBe(3)
    rmSync(join(slot(root, 'e2e'), 'renderer/index.html'))
    go('e2e')
    expect(state.runs).toBe(4)

    go('ordinary')
    renameSync(slot(root, 'e2e'), slot(root, 'ordinary'))
    rmSync(join(root, 'out'), { recursive: true })
    go('ordinary')
    expect(state.runs).toBe(5)
    expect(held()).toBe('ordinary build 5')
  })

  it('leaves out/ and its key as one build when the system refuses the move', () => {
    const root = inputsRepo()
    const { state, go, held } = fakeBuilds(root)
    go('e2e')
    writeFileSync(join(root, '.cache'), 'a file where the cache folder belongs\n')
    go('ordinary')
    expect(state.runs).toBe(2)
    expect(held()).toBe('ordinary build 2')
    expect(JSON.parse(readFileSync(join(root, KEY_FILE), 'utf8')).kind).toBe('ordinary')
    go('e2e')
    expect(state.runs).toBe(3)
    expect(held()).toBe('e2e build 3')
    expect(JSON.parse(readFileSync(join(root, KEY_FILE), 'utf8')).kind).toBe('e2e')
    go('e2e')
    expect(state.runs).toBe(3)
  })

  it('leaves no key on a build cut short, and the other kind stays parked and usable', () => {
    const root = inputsRepo()
    let interrupted = false
    const { state, go, held } = fakeBuilds(root, () => {
      if (interrupted) throw new Error('interrupted')
      return 0
    })
    go('e2e')
    interrupted = true
    expect(() => go('ordinary')).toThrow('interrupted')
    expect(existsSync(join(root, KEY_FILE))).toBe(false)
    expect(existsSync(slot(root, 'e2e'))).toBe(true)
    interrupted = false
    go('ordinary')
    expect(state.runs).toBe(3)
    go('e2e')
    expect(held()).toBe('e2e build 1')
    expect(state.runs).toBe(3)
  })

  it('restores from the slot when out/ is gone, as after a move cut short between its two renames', () => {
    const root = inputsRepo()
    const { state, go, held } = fakeBuilds(root)
    go('e2e')
    go('ordinary')
    rmSync(join(root, 'out'), { recursive: true })
    go('e2e')
    expect(state.runs).toBe(2)
    expect(held()).toBe('e2e build 1')
  })

  it('does not take a half-removed out/ for a build, even with its key file left in it', () => {
    const root = inputsRepo()
    const { state, go, held } = fakeBuilds(root)
    go('e2e')
    go('ordinary')
    go('e2e')
    rmSync(join(root, 'out/renderer'), { recursive: true })
    go('e2e')
    expect(state.runs).toBe(3)
    expect(held()).toBe('e2e build 3')
  })

  it('replaces the parked build of its own kind when forced, and keeps the other kind parked', () => {
    const root = inputsRepo()
    const { state, go, held } = fakeBuilds(root)
    go('e2e')
    go('ordinary')
    go('e2e', { ...GRANT_ENV, ORIVON_FORCE_BUILD: '1' })
    expect(state.runs).toBe(3)
    expect(held()).toBe('e2e build 3')
    expect(existsSync(slot(root, 'e2e'))).toBe(false)
    go('ordinary')
    expect(state.runs).toBe(3)
    go('e2e')
    expect(state.runs).toBe(3)
  })

  it('never touches the cache outside a git checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-build-reuse-nogit-'))
    const { state, go } = fakeBuilds(root)
    go('e2e')
    go('ordinary')
    go('e2e')
    expect(state.runs).toBe(3)
    expect(existsSync(join(root, CACHE_DIR))).toBe(false)
    expect(state.lines).toHaveLength(3)
    expect(state.lines[0]).toMatch(/^Building in full: no key can be trusted here/)
  })
})
