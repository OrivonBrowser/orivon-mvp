import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFileSizes, SOURCE_LIMIT, TEST_LIMIT } from './check-size.mjs'

const fixture = (): string => mkdtempSync(join(tmpdir(), 'orivon-size-'))

/** Writes a file with exactly `lines` newline-terminated lines. */
const writeLines = (root: string, relPath: string, lines: number): void => {
  const full = join(root, ...relPath.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, 'x\n'.repeat(lines))
}

const CLEAN = { ok: true, offenders: [], unreadable: [] }

describe('checkFileSizes', () => {
  describe('the 500-line source limit', () => {
    it('passes a source file at exactly 500 lines', () => {
      const root = fixture()
      writeLines(root, 'src/broker/thing.ts', SOURCE_LIMIT)
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })

    it('fails a source file at 501 lines', () => {
      const root = fixture()
      writeLines(root, 'src/broker/thing.ts', SOURCE_LIMIT + 1)
      const result = checkFileSizes(root)
      expect(result.ok).toBe(false)
      expect(result.offenders).toEqual([
        { file: 'src/broker/thing.ts', lines: 501, limit: 500 }
      ])
    })
  })

  describe('the 800-line test limit', () => {
    it('passes a *.test.ts file at exactly 800 lines', () => {
      const root = fixture()
      writeLines(root, 'src/broker/thing.test.ts', TEST_LIMIT)
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })

    it('fails a *.test.ts file at 801 lines', () => {
      const root = fixture()
      writeLines(root, 'src/broker/thing.test.ts', TEST_LIMIT + 1)
      const result = checkFileSizes(root)
      expect(result.ok).toBe(false)
      expect(result.offenders).toEqual([
        { file: 'src/broker/thing.test.ts', lines: 801, limit: 800 }
      ])
    })

    it('treats scripts/smoke.mjs as a test file, not source', () => {
      const root = fixture()
      writeLines(root, 'scripts/smoke.mjs', TEST_LIMIT)
      expect(checkFileSizes(root)).toEqual(CLEAN)
      writeLines(root, 'scripts/smoke.mjs', TEST_LIMIT + 1)
      expect(checkFileSizes(root).ok).toBe(false)
    })

    it('treats every other file under scripts/ as source, at 500', () => {
      const root = fixture()
      writeLines(root, 'scripts/check-something.mjs', SOURCE_LIMIT + 1)
      const result = checkFileSizes(root)
      expect(result.ok).toBe(false)
      expect(result.offenders).toEqual([
        { file: 'scripts/check-something.mjs', lines: 501, limit: 500 }
      ])
    })

    it('treats anything under test/ as a test file regardless of its own name', () => {
      const root = fixture()
      writeLines(root, 'test/launch-electron.mjs', TEST_LIMIT)
      expect(checkFileSizes(root)).toEqual(CLEAN)
      writeLines(root, 'test/launch-electron.mjs', TEST_LIMIT + 1)
      expect(checkFileSizes(root).ok).toBe(false)
    })

    it('does not extend the test limit to a file merely named *.test.something-else', () => {
      // Only *.test.ts is a test file by the guideline's own literal wording -- a
      // same-named .test.mjs stays source-limited at 500, not 800.
      const root = fixture()
      writeLines(root, 'src/thing.test.mjs', SOURCE_LIMIT + 1)
      const result = checkFileSizes(root)
      expect(result.ok).toBe(false)
      expect(result.offenders).toEqual([
        { file: 'src/thing.test.mjs', lines: 501, limit: 500 }
      ])
    })
  })

  describe('what is scanned at all', () => {
    it('ignores non-source extensions no matter how long', () => {
      const root = fixture()
      writeLines(root, 'docs/development/code-guidelines.md', 5000)
      writeLines(root, 'src/contracts/manifest.json', 5000)
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })

    it('ignores .d.ts declaration files', () => {
      const root = fixture()
      writeLines(root, 'src/contracts/generated.d.ts', SOURCE_LIMIT + 1)
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })

    it('checks .mts and .cts alongside .ts', () => {
      const root = fixture()
      writeLines(root, 'src/thing.mts', SOURCE_LIMIT + 1)
      writeLines(root, 'src/other.cts', SOURCE_LIMIT + 1)
      const result = checkFileSizes(root)
      expect(result.ok).toBe(false)
      expect(result.offenders).toHaveLength(2)
    })

    it('passes on an empty tree', () => {
      expect(checkFileSizes(fixture())).toEqual(CLEAN)
    })
  })

  describe('spike/ is excluded (frozen week-0 scaffolding, predates these rules)', () => {
    it('does not flag an oversized file under spike/', () => {
      const root = fixture()
      writeLines(root, 'spike/gate1b/vite.config.js', SOURCE_LIMIT + 400)
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })
  })

  describe('directories that must never be walked', () => {
    it('skips node_modules', () => {
      const root = fixture()
      writeLines(root, 'node_modules/some-pkg/index.mjs', SOURCE_LIMIT + 1)
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })

    it('skips build/output directories (out, dist, build, release, coverage)', () => {
      const root = fixture()
      writeLines(root, 'out/main/index.js', SOURCE_LIMIT + 1)
      writeLines(root, 'dist/bundle.js', SOURCE_LIMIT + 1)
      writeLines(root, 'build/icon-gen.js', SOURCE_LIMIT + 1)
      writeLines(root, 'release/linux-unpacked/resources/app.js', SOURCE_LIMIT + 1)
      writeLines(root, 'coverage/lcov-report/big.js', SOURCE_LIMIT + 1)
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })

    it('skips dot-directories (.git, .codearbiter, .claude, ...)', () => {
      const root = fixture()
      writeLines(root, '.git/hooks/oversized.mjs', SOURCE_LIMIT + 1)
      writeLines(root, '.codearbiter/cache/big.ts', SOURCE_LIMIT + 1)
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })

    it('does not follow a symlinked directory out of the tree', () => {
      const root = fixture()
      const outside = fixture()
      writeLines(outside, 'huge.ts', SOURCE_LIMIT + 1)
      mkdirSync(join(root, 'src'), { recursive: true })
      symlinkSync(outside, join(root, 'src', 'escape'), 'dir')
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })

    it('does not hang on a symlink cycle', () => {
      const root = fixture()
      mkdirSync(join(root, 'src', 'cyclic'), { recursive: true })
      symlinkSync(join(root, 'src', 'cyclic'), join(root, 'src', 'cyclic', 'self'), 'dir')
      expect(checkFileSizes(root).ok).toBe(true)
    })
  })

  describe('a file this guard cannot read', () => {
    it('fails the check distinctly from a size violation, instead of silently counting it as 0 lines', () => {
      const root = fixture()
      const blocked = join(root, 'blocked.ts')
      writeFileSync(blocked, 'x\n'.repeat(600))
      chmodSync(blocked, 0o000)
      try {
        const result = checkFileSizes(root)
        expect(result.ok).toBe(false)
        // Not a size offender -- its length was never determined.
        expect(result.offenders).toEqual([])
        expect(result.unreadable).toEqual([
          { file: 'blocked.ts', error: expect.any(String) }
        ])
      } finally {
        // Restore permissions before cleanup so the temp dir never leaves a
        // chmod-000 file behind, even if an assertion above throws.
        chmodSync(blocked, 0o644)
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  describe('reporting', () => {
    it('reports every offender, sorted by path', () => {
      const root = fixture()
      writeLines(root, 'src/z-thing.ts', SOURCE_LIMIT + 1)
      writeLines(root, 'src/a-thing.ts', SOURCE_LIMIT + 1)
      const result = checkFileSizes(root)
      expect(result.offenders.map((o) => o.file)).toEqual(['src/a-thing.ts', 'src/z-thing.ts'])
    })

    it('uses forward slashes in reported paths', () => {
      const root = fixture()
      writeLines(root, 'src/broker/policy/thing.ts', SOURCE_LIMIT + 1)
      const result = checkFileSizes(root)
      expect(result.offenders[0]?.file).not.toContain('\\')
      expect(result.offenders[0]?.file).toBe('src/broker/policy/thing.ts')
    })
  })
})
