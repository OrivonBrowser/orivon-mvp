import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { declaredReads, parseDeclarations, planTestRun } from '../test-changed.mjs'

// Every test's declaration is read here, and a folder renamed away voids one, so any change to code brings this test.
// test:changed reads src/ scripts/

const SELF = 'scripts/tests/test-changed.test.ts'

interface Declared { test: string, under: string[] }

const nobody = (): string[] => []
const nothing = (): Declared[] => []

const READER = 'src/a/tests/walks-a.test.ts'
const declaresA = (): Declared[] => [{ test: READER, under: ['src/a/'] }]

describe('planTestRun', () => {
  it('runs the tests related to changed code and test files', () => {
    expect(planTestRun(['src/telemetry/consent.ts', 'src/telemetry/tests/consent.test.ts'], nobody, nothing))
      .toEqual({ mode: 'related', files: ['src/telemetry/consent.ts', 'src/telemetry/tests/consent.test.ts'] })
  })

  it('adds the tests that name a changed document, which they read from disk rather than import', () => {
    const named = (name: string): string[] => name === 'notice.md' ? ['src/telemetry/tests/notice-drift.test.ts'] : []
    expect(planTestRun(['docs/privacy/notice.md', 'docs/decisions/decision-log.md'], named, nothing))
      .toEqual({ mode: 'related', files: ['src/telemetry/tests/notice-drift.test.ts'] })
  })

  it('adds a test for code inside a tree it declares it reads, which no import reaches', () => {
    expect(planTestRun(['src/a/deep/x.ts'], nobody, declaresA))
      .toEqual({ mode: 'related', files: ['src/a/deep/x.ts', READER] })
  })

  it('leaves that test out for code elsewhere', () => {
    expect(planTestRun(['src/telemetry/consent.ts', 'src/ab/y.ts'], nobody, declaresA))
      .toEqual({ mode: 'related', files: ['src/ab/y.ts', 'src/telemetry/consent.ts'] })
  })

  it('adds a test that declares two trees for a change in either, once', () => {
    const declared = (): Declared[] => [{ test: 'src/a/tests/both.test.ts', under: ['src/a/', 'src/b/one.ts'] }]
    expect(planTestRun(['src/a/x.ts'], nobody, declared)).toEqual({ mode: 'related', files: ['src/a/tests/both.test.ts', 'src/a/x.ts'] })
    expect(planTestRun(['src/b/one.ts'], nobody, declared)).toEqual({ mode: 'related', files: ['src/a/tests/both.test.ts', 'src/b/one.ts'] })
    expect(planTestRun(['src/b/two.ts'], nobody, declared)).toEqual({ mode: 'related', files: ['src/b/two.ts'] })
    expect(planTestRun(['src/a/x.ts', 'src/b/one.ts'], nobody, declared)).toEqual({ mode: 'related', files: ['src/a/tests/both.test.ts', 'src/a/x.ts', 'src/b/one.ts'] })
  })

  it('reads the declarations only for code, and only once', () => {
    let reads = 0
    const declared = (): Declared[] => { reads += 1; return declaresA() }
    planTestRun(['docs/README.md'], nobody, declared)
    expect(reads).toBe(0)
    planTestRun(['src/a.ts', 'src/b.ts', 'src/c.ts'], nobody, declared)
    expect(reads).toBe(1)
  })

  it('runs everything when what all tests run under changed', () => {
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.node.json', 'vitest.config.ts']) {
      expect(planTestRun(['src/a.ts', path], nobody, nothing)).toEqual({ mode: 'full', reason: `${path} changed` })
    }
  })

  it('runs nothing when no unit test covers what changed', () => {
    expect(planTestRun(['docs/README.md', 'devlog/journal.md'], nobody, nothing)).toEqual({ mode: 'none' })
  })
})

describe('parseDeclarations', () => {
  it('reads each test\'s trees from its declaration lines, as git grep prints them', () => {
    expect(parseDeclarations([
      'src/a/tests/one.test.ts:// test:changed reads src/a/ src/c/one.ts',
      'src/b/tests/two.test.ts:// test:changed reads src/b/'
    ])).toEqual([
      { test: 'src/a/tests/one.test.ts', under: ['src/a/', 'src/c/one.ts'] },
      { test: 'src/b/tests/two.test.ts', under: ['src/b/'] }
    ])
  })

  it('joins the declarations of a test that makes more than one, and skips a line that is not one', () => {
    expect(parseDeclarations([
      'src/a/tests/x.test.ts:// test:changed reads src/a/',
      'src/a/tests/x.test.ts:// test:changed reads src/b/ src/c/',
      'src/a/tests/x.test.ts:// test:changed reads',
      'src/a/tests/y.test.ts:  // test:changed reads src/d/'
    ])).toEqual([{ test: 'src/a/tests/x.test.ts', under: ['src/a/', 'src/b/', 'src/c/'] }])
  })
})

describe('the declarations in this repository', () => {
  const declared = declaredReads()
  /** The tests a change to one file brings besides this one, which every code change brings. */
  const brought = (path: string): string[] => {
    const plan = planTestRun([path], nobody, () => declared)
    return plan.mode === 'related' ? plan.files.filter((file) => file !== SELF && file !== path) : []
  }

  it('exist: a folder renamed away leaves no declaration that matches nothing', () => {
    expect(declared.length).toBeGreaterThan(5)
    for (const { test, under } of declared) {
      expect(existsSync(test), test).toBe(true)
      for (const path of under) expect(existsSync(path), `${test} reads ${path}`).toBe(true)
    }
  })

  it('bring this test for any change to code under src or scripts', () => {
    for (const path of ['src/telemetry/consent.ts', 'scripts/test-changed.mjs']) {
      expect(planTestRun([path], nobody, () => declared)).toMatchObject({ files: expect.arrayContaining([SELF]) })
    }
  })

  it('bring the test that bundles the shim and the contracts for a change in either', () => {
    for (const path of ['src/shim/wasi-p2/io.ts', 'src/contracts/index.ts']) {
      expect(brought(path)).toContain('src/shim/worker/tests/runtime-bundle.test.ts')
    }
    expect(brought('src/telemetry/consent.ts')).not.toContain('src/shim/worker/tests/runtime-bundle.test.ts')
  })

  it('bring the test of the chunk-check worker for a change to that file alone', () => {
    expect(brought('src/protocols/verifier-host/chunk-check-worker.ts')).toEqual(['src/protocols/verifier-host/tests/chunk-check-worker.test.ts'])
    expect(brought('src/protocols/verifier-host/chunk-check-pool.ts')).toEqual([])
  })
})
