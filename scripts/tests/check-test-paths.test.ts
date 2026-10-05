import { describe, expect, it } from 'vitest'
import { checkLayout, checkTestPaths, findTokens, isExempt, pathSet } from '../check-test-paths.mjs'

/** `files` as a map of path to text; the checker reads from it and never touches a disk. */
const run = (files: Record<string, string>) => checkTestPaths('/nowhere', Object.keys(files), (file) => files[file] ?? null)

describe('findTokens', () => {
  it('finds root-relative and ../-relative paths with their prefix and line', () => {
    expect(findTokens('see test/a/b.test.ts\nand [x](../../test/c.ts).')).toEqual([
      { token: 'test/a/b.test.ts', prefix: '', line: 1 },
      { token: 'test/c.ts', prefix: '../../', line: 2 }
    ])
  })

  it('drops trailing punctuation and a trailing slash', () => {
    expect(findTokens('not test/apps/. and test/x/,').map((t) => t.token)).toEqual(['test/apps', 'test/x'])
  })

  it('skips a placeholder, a node: specifier and a word that merely ends in test', () => {
    expect(findTokens('test/<area>/x and test/{a,b} and node:test/reporters and mytest/x and src/test/y')).toEqual([])
  })
})

describe('pathSet', () => {
  it('holds every file and every directory above it', () => {
    expect([...pathSet(['test/a/b.ts'])].sort()).toEqual(['test', 'test/a', 'test/a/b.ts'])
  })
})

describe('isExempt', () => {
  it('exempts history and synthetic repositories, and checks the live planning pages', () => {
    expect(isExempt('CHANGELOG.md')).toBe(true)
    expect(isExempt('docs/decisions/ADR-0015-x.md')).toBe(true)
    expect(isExempt('devlog/journal.md')).toBe(true)
    expect(isExempt('docs/planning/step-4-app-loader-plan.md')).toBe(true)
    expect(isExempt('scripts/tests/x.test.ts')).toBe(true)
    expect(isExempt('scripts/app-behaviours/tests/x.test.ts')).toBe(true)
    expect(isExempt('docs/planning/compatibility-matrix.md')).toBe(false)
    expect(isExempt('docs/planning/compatibility/table-3c-files.md')).toBe(false)
    expect(isExempt('docs/development/testing.md')).toBe(false)
  })
})

describe('checkTestPaths', () => {
  it('passes when every named path exists, and flags one that does not with its file and line', () => {
    const files = { 'test/a/x.test.ts': 'x', 'docs/a.md': 'ok test/a/x.test.ts\nbad test/a/gone.test.ts' }
    expect(run(files)).toEqual({ ok: false, dangling: [{ file: 'docs/a.md', line: 2, token: 'test/a/gone.test.ts' }] })
    expect(run({ 'test/a/x.test.ts': 'x', 'docs/a.md': 'ok test/a/x.test.ts' }).ok).toBe(true)
  })

  it('resolves a ../ link from the folder of the file that holds it', () => {
    const files = { 'test/a/x.test.ts': 'x', 'docs/development/t.md': '[x](../../test/a/x.test.ts)', 'src/m/README.md': '[x](../test/a/x.test.ts)' }
    expect(run(files).dangling).toEqual([{ file: 'src/m/README.md', line: 1, token: '../test/a/x.test.ts' }])
  })

  it('accepts a folder, and a glob that matches something, and flags one that matches nothing', () => {
    const files = { 'test/a/x.test.ts': 'x', 'docs/a.md': 'test/a and test/**/*.test.ts and test/a/e2e-*.test.ts and test/zzz/*.ts' }
    expect(run(files).dangling.map((d) => d.token)).toEqual(['test/a/e2e-*.test.ts', 'test/zzz/*.ts'])
  })

  it('skips history, generated files and non-text files', () => {
    const files = { 'test/a.ts': 'x', 'CHANGELOG.md': 'test/gone.ts', 'src/runtime.generated.json': 'test/gone.ts', 'logo.png': 'test/gone.ts' }
    expect(run(files).ok).toBe(true)
  })
})

describe('checkLayout', () => {
  const README = '| Folder | Proves |\n|---|---|\n| `alpha/` | a |\n| [`apps/`](apps/), `fixtures/` | b |\n'

  it('passes when every folder has a row and every row has a folder', () => {
    expect(checkLayout(['test/alpha/e2e-a.test.ts', 'test/apps/x/y.js', 'test/fixtures/z.html', 'test/README.md'], README)).toEqual([])
  })

  it('flags a spec at the top of test/, a folder with no row, and a row with no folder', () => {
    const problems = checkLayout(['test/e2e-loose.test.ts', 'test/alpha/e2e-a.test.ts', 'test/beta/x.ts', 'test/apps/x/y.js'], README).join('\n')
    expect(problems).toContain('test/e2e-loose.test.ts: a spec belongs in a folder')
    expect(problems).toContain('test/beta/ has no row')
    expect(problems).toContain('names fixtures/, which does not exist')
  })

  it('does not count a helper or the README at the top of test/ as a spec', () => {
    expect(checkLayout(['test/alpha/e2e-a.test.ts', 'test/vitest.e2e.config.ts', 'test/README.md', 'test/apps/a', 'test/fixtures/b'], README)).toEqual([])
  })
})
