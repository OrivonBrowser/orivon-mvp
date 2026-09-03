import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkComments, PREAMBLE_LIMIT } from './check-comments.mjs'

/** A git repo whose tracked files are exactly those given. */
const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-comments-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

/** `count` comment lines, then a line of code. */
const preamble = (count: number, code = 'export const x = 1\n'): string =>
  Array.from({ length: count }, (_, i) => `// line ${i + 1}\n`).join('') + code

describe('checkComments', () => {
  describe('the budget', () => {
    it('accepts a file whose leading comment block is at the limit', () => {
      const result = checkComments(repo({ 'src/a.ts': preamble(PREAMBLE_LIMIT) }))
      expect(result.ok).toBe(true)
      expect(result.offenders).toEqual([])
    })

    it('rejects a file one line over the limit', () => {
      const result = checkComments(repo({ 'src/a.ts': preamble(PREAMBLE_LIMIT + 1) }))
      expect(result.ok).toBe(false)
      expect(result.offenders).toEqual([
        { file: 'src/a.ts', preamble: PREAMBLE_LIMIT + 1, limit: PREAMBLE_LIMIT }
      ])
    })

    it('measures a block comment the same as line comments', () => {
      const body = '/**\n' + ' * x\n'.repeat(PREAMBLE_LIMIT) + ' */\nexport const x = 1\n'
      const result = checkComments(repo({ 'src/a.ts': body }))
      expect(result.ok).toBe(false)
      expect(result.offenders[0]?.preamble).toBe(PREAMBLE_LIMIT + 2)
    })

    it('counts a blank line between two comment paragraphs', () => {
      const body = '// one\n\n// two\nexport const x = 1\n'
      expect(checkComments(repo({ 'src/a.ts': body })).offenders).toEqual([])
      // Measured through a limit of 2 to prove the blank line was counted:
      // without it this preamble would be 2 lines, not 3.
      const tight = checkComments(repo({ 'src/a.ts': body }), { limit: 2 })
      expect(tight.offenders[0]?.preamble).toBe(3)
    })

    it('does not count blank lines between the comment and the code', () => {
      const body = '// one\n\n\nexport const x = 1\n'
      expect(checkComments(repo({ 'src/a.ts': body }), { limit: 1 }).ok).toBe(true)
    })

    it('ignores comments that are not at the top of the file', () => {
      const body = 'import { y } from "./y.js"\n' + '// a\n'.repeat(40) + 'export const x = 1\n'
      expect(checkComments(repo({ 'src/a.ts': body })).ok).toBe(true)
    })

    it('does not count a shebang toward the preamble', () => {
      const body = '#!/usr/bin/env node\n' + preamble(PREAMBLE_LIMIT)
      expect(checkComments(repo({ 'scripts/a.mjs': body })).ok).toBe(true)
    })

    it('measures a file that is entirely comments', () => {
      const result = checkComments(repo({ 'src/a.ts': '// a\n'.repeat(PREAMBLE_LIMIT + 5) }))
      expect(result.offenders[0]?.preamble).toBe(PREAMBLE_LIMIT + 5)
    })
  })

  describe('what it checks', () => {
    it('exempts src/contracts/, whose doc comments are the product documentation', () => {
      const result = checkComments(repo({ 'src/contracts/a.ts': preamble(80) }))
      expect(result.ok).toBe(true)
    })

    it('exempts spike/, which is documented throwaway scaffolding', () => {
      expect(checkComments(repo({ 'spike/gate1a/shim/a.js': preamble(80) })).ok).toBe(true)
    })

    it('does not check test files', () => {
      const root = repo({
        'src/a.test.ts': preamble(80),
        'test/b.ts': preamble(80),
        'scripts/smoke.mjs': preamble(80)
      })
      expect(checkComments(root).ok).toBe(true)
    })

    it('does check ordinary files under scripts/ and apps/', () => {
      const root = repo({ 'scripts/a.mjs': preamble(80), 'apps/fixture/b.js': preamble(80) })
      expect(checkComments(root).offenders.map((o) => o.file))
        .toEqual(['apps/fixture/b.js', 'scripts/a.mjs'])
    })

    it('ignores declaration files and non-source files', () => {
      const root = repo({
        'src/a.d.ts': preamble(80),
        'docs/a.md': '<!-- x -->\n'.repeat(80),
        'a.json': '{}\n'
      })
      expect(checkComments(root).ok).toBe(true)
    })

    it('ignores files that are not tracked by git', () => {
      const root = repo({ 'src/a.ts': preamble(2) })
      writeFileSync(join(root, 'src/untracked.ts'), preamble(80))
      expect(checkComments(root).ok).toBe(true)
    })
  })

  describe('the escape hatch', () => {
    it('accepts a long preamble carrying the pragma and a reason', () => {
      const body = '// orivon:comment-budget -- documents a security property found by accident\n' +
        preamble(80)
      expect(checkComments(repo({ 'src/a.ts': body })).ok).toBe(true)
    })

    it('accepts the pragma inside a block comment', () => {
      const body = '/**\n * orivon:comment-budget -- the wire format is the reason\n' +
        ' * x\n'.repeat(80) + ' */\nexport const x = 1\n'
      expect(checkComments(repo({ 'src/a.ts': body })).ok).toBe(true)
    })

    it('REJECTS the pragma with no reason after it', () => {
      const body = '// orivon:comment-budget\n' + preamble(80)
      const result = checkComments(repo({ 'src/a.ts': body }))
      expect(result.ok).toBe(false)
      expect(result.unjustified).toEqual([{ file: 'src/a.ts' }])
    })

    it('REJECTS the pragma whose reason is only whitespace', () => {
      const body = '// orivon:comment-budget --   \n' + preamble(80)
      expect(checkComments(repo({ 'src/a.ts': body })).ok).toBe(false)
    })

    it('ignores a pragma that is not in the preamble', () => {
      const body = preamble(80) + '// orivon:comment-budget -- too late to count\n'
      expect(checkComments(repo({ 'src/a.ts': body })).ok).toBe(false)
    })

    it('reports every exemption so the list stays reviewable', () => {
      const body = '// orivon:comment-budget -- the reason\n' + preamble(80)
      expect(checkComments(repo({ 'src/a.ts': body })).exempted).toEqual([
        { file: 'src/a.ts', reason: 'the reason' }
      ])
    })
  })

  describe('the baseline', () => {
    it('accepts a listed file that is over the limit', () => {
      const root = repo({
        'src/a.ts': preamble(80),
        'scripts/comment-budget-baseline.txt': 'src/a.ts\n'
      })
      expect(checkComments(root).ok).toBe(true)
    })

    it('reports listed files, so the debt is visible on every run', () => {
      const root = repo({
        'src/a.ts': preamble(80),
        'scripts/comment-budget-baseline.txt': '# a comment\n\nsrc/a.ts\n'
      })
      expect(checkComments(root).baselined).toEqual(['src/a.ts'])
    })

    it('does not let the baseline cover a file added to it after it was written', () => {
      const root = repo({
        'src/a.ts': preamble(80),
        'src/b.ts': preamble(80),
        'scripts/comment-budget-baseline.txt': 'src/a.ts\n'
      })
      expect(checkComments(root).offenders.map((o) => o.file)).toEqual(['src/b.ts'])
    })

    it('FAILS on a baseline entry that is now compliant, so the list can only shrink', () => {
      const root = repo({
        'src/a.ts': preamble(2),
        'scripts/comment-budget-baseline.txt': 'src/a.ts\n'
      })
      const result = checkComments(root)
      expect(result.ok).toBe(false)
      expect(result.stale).toEqual(['src/a.ts'])
    })

    it('FAILS on a baseline entry for a file that no longer exists', () => {
      const root = repo({ 'scripts/comment-budget-baseline.txt': 'src/gone.ts\n' })
      expect(checkComments(root).stale).toEqual(['src/gone.ts'])
    })
  })

  describe('reporting', () => {
    it('sorts offenders by path', () => {
      const root = repo({ 'src/z.ts': preamble(80), 'src/a.ts': preamble(80) })
      expect(checkComments(root).offenders.map((o) => o.file)).toEqual(['src/a.ts', 'src/z.ts'])
    })

    it('reports an unreadable file rather than passing it silently', () => {
      // Tracked by git, absent from the filesystem: its preamble is unknown,
      // not zero, so it must not read as compliant.
      const root = repo({ 'src/gone.ts': preamble(2) })
      rmSync(join(root, 'src/gone.ts'))
      const result = checkComments(root)
      expect(result.ok).toBe(false)
      expect(result.unreadable.map((u) => u.file)).toEqual(['src/gone.ts'])
    })
  })
})
