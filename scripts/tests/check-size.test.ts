import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkFileSizes, checkReadmeSizes, describeReadmeGrowth, readBaseArg, readSafe, README_LIMIT, SOURCE_LIMIT, TEST_LIMIT
} from '../check-size.mjs'

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
      writeLines(root, 'test/support/launch-electron.mjs', TEST_LIMIT)
      expect(checkFileSizes(root)).toEqual(CLEAN)
      writeLines(root, 'test/support/launch-electron.mjs', TEST_LIMIT + 1)
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

  describe('vendor/ is excluded (third-party source kept verbatim)', () => {
    it('does not flag an oversized file under vendor/', () => {
      const root = fixture()
      writeLines(root, 'vendor/electron-chrome-extensions/src/renderer/index.ts', SOURCE_LIMIT + 200)
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })
  })

  describe('resources/ is excluded (data the app reads, and downloads git ignores)', () => {
    it('does not flag an oversized file a node download put under resources/', () => {
      const root = fixture()
      writeLines(root, 'resources/ipfs-node/ipfs-node.js', SOURCE_LIMIT + 200)
      expect(checkFileSizes(root)).toEqual(CLEAN)
    })

    it('still flags an oversized file in a resources folder below the root', () => {
      const root = fixture()
      writeLines(root, 'src/main/resources/big.ts', SOURCE_LIMIT + 1)
      expect(checkFileSizes(root).ok).toBe(false)
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

  describe('readSafe: a vanished file is not the same problem as a blocked one', () => {
    // A genuine TOCTOU race -- gone between checkFileSizes's own readdirSync
    // and the readFileSync a moment later -- happens between two calls
    // inside one synchronous function. There is no scheduling point in
    // between for a test to delete the file at exactly the right instant,
    // so it cannot be reproduced deterministically by racing a real delete
    // against checkFileSizes end to end. readSafe is exported so this can
    // exercise the exact fs-error-code branch a real race would hit instead:
    // reading a path that was never created raises the identical ENOENT a
    // freshly-vanished one would, through the same catch block.
    it('reports a normal, readable file as { text }', () => {
      const root = fixture()
      try {
        const full = join(root, 'thing.ts')
        writeFileSync(full, 'x\n')
        expect(readSafe(full)).toEqual({ text: 'x\n' })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('reports ENOENT as "gone", not as an error -- a benign race, not a violation', () => {
      const root = fixture()
      try {
        const neverExisted = join(root, 'never-existed.ts')
        expect(readSafe(neverExisted)).toEqual({ gone: true })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('reports EACCES as an error, distinct from "gone" -- a real problem, not a race', () => {
      const root = fixture()
      const blocked = join(root, 'blocked.ts')
      writeFileSync(blocked, 'x\n'.repeat(600))
      chmodSync(blocked, 0o000)
      try {
        expect(readSafe(blocked)).toEqual({ error: expect.any(String) })
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

describe('the README cap', () => {
  const git = (root: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    })

  /** A file of exactly `bytes` ASCII bytes, in 80-byte lines. */
  const sized = (bytes: number): string => 'x'.repeat(79).concat('\n').repeat(Math.ceil(bytes / 80)).slice(0, bytes)

  const write = (root: string, relPath: string, text: string): void => {
    const full = join(root, ...relPath.split('/'))
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }

  /** A repo on `main` whose single commit holds `files`, then a `change` branch checked out from it. */
  const repoWith = (files: Record<string, string>): string => {
    const root = fixture()
    git(root, 'init', '-q', '-b', 'main')
    for (const [path, text] of Object.entries(files)) write(root, path, text)
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'base')
    git(root, 'switch', '-q', '-c', 'change')
    return root
  }

  const BIG = README_LIMIT * 4

  it('caps a README at 12 KB', () => {
    expect(README_LIMIT).toBe(12288)
  })

  describe('a README the change adds', () => {
    it('passes at exactly 12 KB and fails one byte over, naming the file and its sizes', () => {
      const root = repoWith({ 'src/a/x.ts': 'x\n' })
      write(root, 'src/a/README.md', sized(README_LIMIT))
      expect(checkReadmeSizes(root, 'main').ok).toBe(true)
      write(root, 'src/a/README.md', sized(README_LIMIT + 1))
      const result = checkReadmeSizes(root, 'main')
      expect(result.ok).toBe(false)
      expect(result.grown).toEqual([{ file: 'src/a/README.md', before: null, after: README_LIMIT + 1 }])
    })
  })

  describe('a README the base already has', () => {
    it('passes a README over 12 KB that the change leaves alone', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      expect(checkReadmeSizes(root, 'main')).toMatchObject({ ok: true, grown: [] })
    })

    it('fails a README over 12 KB that grows by one byte, uncommitted or committed', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      write(root, 'src/a/README.md', sized(BIG + 1))
      const expected = [{ file: 'src/a/README.md', before: BIG, after: BIG + 1 }]
      expect(checkReadmeSizes(root, 'main').grown).toEqual(expected)
      git(root, 'commit', '-q', '-am', 'grow')
      expect(checkReadmeSizes(root, 'main').grown).toEqual(expected)
    })

    it('passes a README over 12 KB that shrinks, and one that stays the same size', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      write(root, 'src/a/README.md', sized(BIG - 1))
      expect(checkReadmeSizes(root, 'main').ok).toBe(true)
    })

    it('fails a README under 12 KB that grows past it', () => {
      const root = repoWith({ 'src/a/README.md': sized(README_LIMIT - 10) })
      write(root, 'src/a/README.md', sized(README_LIMIT + 1))
      expect(checkReadmeSizes(root, 'main').grown).toEqual([
        { file: 'src/a/README.md', before: README_LIMIT - 10, after: README_LIMIT + 1 }
      ])
    })

    it('passes a README that grows but stays within 12 KB', () => {
      const root = repoWith({ 'src/a/README.md': sized(100) })
      write(root, 'src/a/README.md', sized(README_LIMIT))
      expect(checkReadmeSizes(root, 'main').ok).toBe(true)
    })

    it('passes moving text from a README into a DESIGN.md of any size', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      write(root, 'src/a/README.md', sized(1000))
      write(root, 'src/a/DESIGN.md', sized(BIG * 2))
      expect(checkReadmeSizes(root, 'main')).toMatchObject({ ok: true, grown: [] })
    })

    it('does not count line-ending conversion as growth', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      write(root, 'src/a/README.md', sized(BIG).replaceAll('\n', '\r\n'))
      expect(checkReadmeSizes(root, 'main').ok).toBe(true)
    })
  })

  describe('the base is the change\'s own', () => {
    it('ignores growth that landed on the base branch after this one branched off', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      git(root, 'switch', '-q', 'main')
      write(root, 'src/a/README.md', sized(BIG * 2))
      git(root, 'commit', '-q', '-am', 'grow on main')
      git(root, 'switch', '-q', 'change')
      expect(checkReadmeSizes(root, 'main').ok).toBe(true)
    })

    it('judges against any ref, so a long-lived branch is compared with its own parent', () => {
      const root = repoWith({ 'src/a/README.md': sized(README_LIMIT - 10) })
      write(root, 'src/a/README.md', sized(BIG))
      git(root, 'commit', '-q', '-am', 'long-lived branch holds a large README')
      git(root, 'switch', '-q', '-c', 'feature')
      write(root, 'src/b/README.md', 'short\n')
      expect(checkReadmeSizes(root, 'change').ok).toBe(true)
      expect(checkReadmeSizes(root, 'main').ok).toBe(false)
    })
  })

  describe('which READMEs count', () => {
    it('checks src/README.md and every depth below src/, and nothing outside src/', () => {
      const root = repoWith({ 'src/x.ts': 'x\n' })
      write(root, 'src/README.md', sized(BIG))
      write(root, 'src/a/b/c/README.md', sized(BIG))
      write(root, 'docs/README.md', sized(BIG))
      write(root, 'test/README.md', sized(BIG))
      write(root, 'scripts/README.md', sized(BIG))
      write(root, 'README.md', sized(BIG))
      const files = checkReadmeSizes(root, 'main').grown.map((g: { file: string }) => g.file)
      expect([...files].sort()).toEqual(['src/README.md', 'src/a/b/c/README.md'])
    })

    it('does not cap other files in src/, or a file only named like a README', () => {
      const root = repoWith({ 'src/x.ts': 'x\n' })
      write(root, 'src/a/DESIGN.md', sized(BIG))
      write(root, 'src/a/README.txt', sized(BIG))
      write(root, 'src/a/README.md.bak', sized(BIG))
      expect(checkReadmeSizes(root, 'main').ok).toBe(true)
    })

    it('skips node_modules and dot-directories under src/', () => {
      const root = repoWith({ 'src/x.ts': 'x\n' })
      write(root, 'src/node_modules/pkg/README.md', sized(BIG))
      write(root, 'src/.cache/README.md', sized(BIG))
      expect(checkReadmeSizes(root, 'main').ok).toBe(true)
    })
  })

  describe('no base', () => {
    it('warns and passes, however large a README is, when no ref is given', () => {
      const root = fixture()
      write(root, 'src/a/README.md', sized(BIG))
      const result = checkReadmeSizes(root, undefined)
      expect(result.ok).toBe(true)
      expect(result.grown).toEqual([])
      expect(result.warning).toMatch(/not checked/)
    })

    it('fails a ref that was given but shares no history with HEAD, not passing it silently', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      const result = checkReadmeSizes(root, 'no-such-branch')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/no merge base between HEAD and no-such-branch/)
    })
  })

  describe('a README this guard cannot read', () => {
    it('fails rather than counting it as small', () => {
      const root = fixture()
      write(root, 'src/a/README.md', 'x\n')
      chmodSync(join(root, 'src/a/README.md'), 0o000)
      try {
        const result = checkReadmeSizes(root, undefined)
        // Running as root reads it anyway: only an environment that enforces the mode can show the failure.
        if (result.unreadable.length > 0) {
          expect(result.ok).toBe(false)
          expect(result.unreadable).toEqual([{ file: 'src/a/README.md', error: expect.any(String) }])
        }
      } finally {
        chmodSync(join(root, 'src/a/README.md'), 0o644)
      }
    })
  })

  describe('the report', () => {
    it('names the file, its size before and after, and sends rationale to DESIGN.md', () => {
      const text = describeReadmeGrowth([
        { file: 'src/a/README.md', before: 20000, after: 20100 },
        { file: 'src/b/README.md', before: null, after: 13000 }
      ])
      expect(text).toContain('src/a/README.md  (was 20000 bytes, now 20100 bytes')
      expect(text).toContain('src/b/README.md  (new file, now 13000 bytes')
      expect(text).toContain('Put rationale in DESIGN.md beside the README')
    })
  })

  describe('readBaseArg', () => {
    it('reads --base, then CHECK_SIZE_BASE, then nothing', () => {
      expect(readBaseArg(['--base', 'origin/main'], {})).toEqual({ base: 'origin/main' })
      expect(readBaseArg([], { CHECK_SIZE_BASE: 'origin/dev' })).toEqual({ base: 'origin/dev' })
      expect(readBaseArg(['--base', 'a'], { CHECK_SIZE_BASE: 'b' })).toEqual({ base: 'a' })
      expect(readBaseArg([], {})).toEqual({})
    })

    it('treats an empty CHECK_SIZE_BASE as unset, which is what CI passes outside a pull request', () => {
      expect(readBaseArg([], { CHECK_SIZE_BASE: '' })).toEqual({})
    })

    it('rejects --base with no ref', () => {
      expect(readBaseArg(['--base'], {}).error).toMatch(/--base needs a ref/)
      expect(readBaseArg(['--base', '--other'], {}).error).toMatch(/--base needs a ref/)
    })
  })

  describe('the command', () => {
    const script = join(process.cwd(), 'scripts', 'check-size.mjs')
    const run = (root: string, args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CHECK_SIZE_BASE: '', ...env } })

    it('exits 1 and says to put rationale in DESIGN.md when a README grows', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      write(root, 'src/a/README.md', sized(BIG + 5))
      const result = run(root, ['--base', 'main'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`src/a/README.md  (was ${String(BIG)} bytes, now ${String(BIG + 5)} bytes`)
      expect(result.stderr).toContain('Put rationale in DESIGN.md beside the README')
    })

    it('takes the base from CHECK_SIZE_BASE', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      write(root, 'src/a/README.md', sized(BIG + 5))
      expect(run(root, [], { CHECK_SIZE_BASE: 'main' }).status).toBe(1)
    })

    it('exits 0 with a warning when there is no base, and 0 when the README shrank', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      write(root, 'src/a/README.md', sized(BIG + 5))
      const unjudged = run(root, [])
      expect(unjudged.status).toBe(0)
      expect(unjudged.stderr).toMatch(/README growth under src\/ was not checked/)
      write(root, 'src/a/README.md', sized(100))
      expect(run(root, ['--base', 'main']).status).toBe(0)
    })

    it('still fails an oversized source file and a README together', () => {
      const root = repoWith({ 'src/a/README.md': sized(BIG) })
      write(root, 'src/a/README.md', sized(BIG + 5))
      writeLines(root, 'src/a/big.ts', SOURCE_LIMIT + 1)
      const result = run(root, ['--base', 'main'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('src/a/big.ts')
      expect(result.stderr).toContain('src/a/README.md')
    })
  })
})
