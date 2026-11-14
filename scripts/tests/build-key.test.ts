import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildKey, configImports, isUnitTest } from '../build-key.mjs'
import { GRANT_ENV, commitAll, git, inputsRepo, write } from './build-key.test-helpers.js'

const e2e = (root: string, env: NodeJS.ProcessEnv = GRANT_ENV): string | null => buildKey(root, 'e2e', env)

describe('buildKey', { timeout: 30_000 }, () => {
  it('gives the same key for the same inputs, on every call and in a copy of the checkout', () => {
    const root = inputsRepo()
    expect(e2e(root)).toMatch(/^[0-9a-f]{64}$/)
    expect(e2e(root)).toBe(e2e(root))
    const copy = mkdtempSync(join(tmpdir(), 'orivon-build-key-copy-'))
    git(copy, 'clone', '-q', root, '.')
    write(copy, 'node_modules/electron/package.json', '{"version":"1.0.0"}\n')
    write(copy, 'node_modules/electron-vite/package.json', '{"version":"1.0.0"}\n')
    write(copy, 'node_modules/vite/package.json', '{"version":"1.0.0"}\n')
    write(copy, 'node_modules/.package-lock.json', '{}\n')
    expect(e2e(copy)).toBe(e2e(root))
  })

  describe('what changes it', () => {
    it.each([
      ['an edit to a source file', (root: string) => write(root, 'src/main/index.ts', 'export const a = 2\n')],
      ['an edit to a file under vendor', (root: string) => write(root, 'vendor/lib/index.js', 'module.exports = 2\n')],
      ['an edit to a file whose name only contains tests or test', (root: string) => write(root, 'src/main/attests/seal.ts', 'export const s = 1\n')],
      ['an edit to a test hook the build bundles', (root: string) => write(root, 'src/main/store-test-hook.ts', 'export const k = 1\n')],
      ['an edit to a resource manifest', (root: string) => write(root, 'resources/flavours.json', '[1]\n')],
      ['an edit to the privacy notice the Settings page embeds', (root: string) => write(root, 'docs/privacy/notice.md', 'new notice\n')],
      ['an edit to the build configuration', (root: string) => write(root, 'electron.vite.config.ts', 'export default { a: 1 }\n')],
      ['an edit to a script the configuration imports', (root: string) => write(root, 'scripts/build-commit.ts', 'export const x = 1\n')],
      ['an edit to package.json', (root: string) => write(root, 'package.json', '{"name":"app","version":"1.0.1"}\n')],
      ['a new untracked source file', (root: string) => write(root, 'src/main/new.ts', 'export const b = 1\n')],
      ['a deleted source file', (root: string) => rmSync(join(root, 'src/renderer/index.html'))]
    ])('%s', (_name, change) => {
      const root = inputsRepo()
      const before = e2e(root)
      change(root)
      expect(e2e(root)).not.toBe(before)
    })

    it('a new untracked file whose content then changes', () => {
      const root = inputsRepo()
      write(root, 'src/main/new.ts', 'export const b = 1\n')
      const first = e2e(root)
      write(root, 'src/main/new.ts', 'export const b = 2\n')
      expect(e2e(root)).not.toBe(first)
    })

    it('the dev-grant flag, the build kind and the Vite variables', () => {
      const root = inputsRepo()
      const keys = [
        e2e(root, GRANT_ENV),
        buildKey(root, 'ordinary', GRANT_ENV),
        buildKey(root, 'ordinary', {}),
        buildKey(root, 'e2e', {}),
        buildKey(root, 'ordinary', { VITE_SOMETHING: '1' }),
        buildKey(root, 'ordinary', { NODE_ENV: 'development' })
      ]
      expect(new Set(keys).size).toBe(keys.length)
    })

    it('the Node version, the platform and the installed Electron, electron-vite and Vite', () => {
      const root = inputsRepo()
      const keys = [
        e2e(root),
        buildKey(root, 'e2e', GRANT_ENV, { node: 'v0.0.1' }),
        buildKey(root, 'e2e', GRANT_ENV, { platform: 'plan9' })
      ]
      for (const name of ['electron', 'electron-vite', 'vite']) {
        write(root, `node_modules/${name}/package.json`, '{"version":"9.9.9"}\n')
        keys.push(e2e(root))
        write(root, `node_modules/${name}/package.json`, '{"version":"1.0.0"}\n')
      }
      write(root, 'node_modules/.package-lock.json', '{"packages":{"x":{}}}\n')
      keys.push(e2e(root))
      expect(new Set(keys).size).toBe(keys.length)
    })
  })

  describe('what leaves it alone', () => {
    it.each([
      ['an edit under test/', (root: string) => write(root, 'test/spec.test.ts', 'export const t = 1\n')],
      ['an edit to a unit test under a tests/ folder', (root: string) => write(root, 'src/main/tests/omnibox.test.ts', 'export const t = 1\n')],
      ['an edit to a fixture under a tests/ folder', (root: string) => write(root, 'src/main/tests/fixtures/vectors.json', '[1]\n')],
      ['an edit to a helper under a __tests__/ folder', (root: string) => write(root, 'src/shim/__tests__/helper.ts', 'export const h = 1\n')],
      ['an edit to a *.test.mjs file', (root: string) => write(root, 'src/main/old.test.mjs', 'export const m = 1\n')],
      ['a new unit test', (root: string) => write(root, 'src/broker/tests/new.test.ts', 'export {}\n')],
      ['a deleted unit test', (root: string) => rmSync(join(root, 'src/main/tests/omnibox.test.ts'))],
      ['a new file under test/', (root: string) => write(root, 'test/new.test.ts', 'export {}\n')],
      ['an edit to a document the build does not read', (root: string) => write(root, 'docs/elsewhere.md', 'other prose\n')],
      ['an edit to a script the build does not import', (root: string) => write(root, 'scripts/unrelated.mjs', 'export const z = 1\n')],
      ['a file git ignores, under an input', (root: string) => write(root, 'src/cache/x.json', '{}\n')],
      ['build output', (root: string) => write(root, 'out/main/index.js', 'x\n')]
    ])('%s', (_name, change) => {
      const root = inputsRepo()
      const before = e2e(root)
      change(root)
      expect(e2e(root)).toBe(before)
    })

    it('ORIVON_ENABLE_DEV_GRANT=0, which the build folds to the same boolean as unset', () => {
      const root = inputsRepo()
      expect(buildKey(root, 'ordinary', { ORIVON_ENABLE_DEV_GRANT: '0' })).toBe(buildKey(root, 'ordinary', {}))
    })

    it('staging or committing the same edit, and an empty commit', () => {
      const root = inputsRepo()
      write(root, 'src/main/index.ts', 'export const a = 2\n')
      const edited = e2e(root)
      git(root, 'add', '-A')
      expect(e2e(root)).toBe(edited)
      commitAll(root, 'edit')
      expect(e2e(root)).toBe(edited)
      commitAll(root, 'nothing')
      expect(e2e(root)).toBe(edited)
    })

    it('an edit that was staged and then undone in the working tree', () => {
      const root = inputsRepo()
      const before = e2e(root)
      write(root, 'src/main/index.ts', 'export const a = 2\n')
      git(root, 'add', '-A')
      write(root, 'src/main/index.ts', 'export const a = 1\n')
      expect(e2e(root)).toBe(before)
    })
  })

  describe('when no key can be trusted', () => {
    it('is null outside a git checkout', () => {
      const root = mkdtempSync(join(tmpdir(), 'orivon-build-key-nogit-'))
      writeFileSync(join(root, 'package.json'), '{}\n')
      expect(e2e(root)).toBeNull()
    })

    it('is null in a directory below the top of a checkout', () => {
      const root = inputsRepo()
      write(root, 'nested/src/main/index.ts', 'export {}\n')
      expect(e2e(join(root, 'nested'))).toBeNull()
    })

    it('is null while a merge conflict is open', () => {
      const root = inputsRepo()
      git(root, 'checkout', '-q', '-b', 'other')
      write(root, 'src/main/index.ts', 'export const a = 3\n')
      commitAll(root, 'other')
      git(root, 'checkout', '-q', '-')
      write(root, 'src/main/index.ts', 'export const a = 4\n')
      commitAll(root, 'here')
      try { git(root, 'merge', 'other') } catch { /* the conflict is the point */ }
      expect(e2e(root)).toBeNull()
    })

    it('is null for a file marked assume-unchanged, which hides its edits from git', () => {
      const root = inputsRepo()
      expect(e2e(root)).not.toBeNull()
      git(root, 'update-index', '--assume-unchanged', 'src/main/index.ts')
      expect(e2e(root)).toBeNull()
    })

    it('stays a key when a unit test is marked assume-unchanged, which no build reads', () => {
      const root = inputsRepo()
      git(root, 'update-index', '--assume-unchanged', 'src/main/tests/omnibox.test.ts')
      expect(e2e(root)).not.toBeNull()
    })

    it('is null without npm\'s record of the installed packages', () => {
      const root = inputsRepo()
      rmSync(join(root, 'node_modules/.package-lock.json'))
      expect(e2e(root)).toBeNull()
    })

    it('rejects a build kind it does not know', () => {
      expect(() => buildKey(inputsRepo(), 'dev' as 'e2e', {})).toThrow(/unknown build kind/)
    })
  })

  describe('the files the build configuration imports', () => {
    /** A checkout whose configuration loads a bundle plugin that loads a helper, and a script nothing loads. */
    const withPlugins = (): string => {
      const root = inputsRepo()
      write(root, 'electron.vite.config.ts', "import { plugin } from './scripts/plugin.js'\nexport default { plugin }\n")
      write(root, 'scripts/plugin.ts', "import { help } from './helper.mjs'\nexport const plugin = help\n")
      write(root, 'scripts/helper.mjs', "import { deep } from '../src/main/deep.js'\nexport const help = deep\n")
      write(root, 'src/main/deep.ts', 'export const deep = 1\n')
      write(root, 'scripts/loose.ts', 'export const loose = 1\n')
      commitAll(root, 'plugins')
      return root
    }

    it('are found as ./x.js for the ./x.ts or ./x.mjs beside it, and the files they import in turn', () => {
      expect(configImports(inputsRepo())).toEqual(['scripts/build-commit.ts'])
      expect(configImports(withPlugins())).toEqual(['scripts/helper.mjs', 'scripts/plugin.ts', 'src/main/deep.ts'])
    })

    it.each([
      ['an edit to the file the configuration imports', 'scripts/plugin.ts'],
      ['an edit to a file that one imports', 'scripts/helper.mjs']
    ])('%s moves the key, and an edit to a script nothing imports does not', (_name, path) => {
      const root = withPlugins()
      const before = e2e(root)
      write(root, 'scripts/loose.ts', 'export const loose = 2\n')
      expect(e2e(root)).toBe(before)
      write(root, path, `${path.endsWith('.ts') ? 'export const plugin = 1' : 'export const help = 1'}\n`)
      expect(e2e(root)).not.toBe(before)
    })

    it('cover an import the configuration gains, with no change to BUILD_INPUTS', () => {
      const root = withPlugins()
      const before = e2e(root)
      write(root, 'scripts/more.ts', 'export const more = 1\n')
      write(root, 'electron.vite.config.ts', "import './scripts/plugin.js'\nimport './scripts/more.js'\n")
      const gained = e2e(root)
      expect(gained).not.toBe(before)
      write(root, 'scripts/more.ts', 'export const more = 2\n')
      expect(e2e(root)).not.toBe(gained)
    })

    it('follow a cycle once, and a unit test the configuration imports counts', () => {
      const root = withPlugins()
      write(root, 'scripts/helper.mjs', "import { plugin } from './plugin.js'\nexport const help = plugin\n")
      write(root, 'electron.vite.config.ts', "import './scripts/plugin.js'\nimport './scripts/tests/shared.js'\n")
      write(root, 'scripts/tests/shared.ts', 'export const shared = 1\n')
      expect(configImports(root)).toEqual(['scripts/helper.mjs', 'scripts/plugin.ts', 'scripts/tests/shared.ts'])
      const before = e2e(root)
      write(root, 'scripts/tests/shared.ts', 'export const shared = 2\n')
      expect(e2e(root)).not.toBe(before)
    })

    it('find a folder import by the index file in it', () => {
      const root = withPlugins()
      write(root, 'electron.vite.config.ts', "import './scripts/folder'\n")
      write(root, 'scripts/folder/index.mjs', 'export {}\n')
      expect(configImports(root)).toEqual(['scripts/folder/index.mjs'])
    })

    it('ignore a path in a comment, and read an import after a string holding two slashes', () => {
      const root = withPlugins()
      write(root, 'electron.vite.config.ts', [
        "// Chunked, each would require('./chunks/...') and import './nowhere.js'",
        '/* from "./gone.js"',
        "   import('./also-gone.js') */",
        "const url = 'http://example.test/'; import './scripts/plugin.js'",
        ''
      ].join('\n'))
      expect(configImports(root)).toEqual(['scripts/helper.mjs', 'scripts/plugin.ts', 'src/main/deep.ts'])
    })

    it.each([
      ['an import that names no file', (root: string) => write(root, 'electron.vite.config.ts', "import './scripts/missing.js'\n")],
      ['an imported file deleted from the working tree', (root: string) => rmSync(join(root, 'scripts/plugin.ts'))],
      ['an imported file that git ignores', (root: string) => {
        write(root, '.gitignore', 'node_modules/\nout/\nscripts/plugin.ts\n')
        git(root, 'rm', '-q', '--cached', 'scripts/plugin.ts')
      }],
      ['an import that leaves the checkout', (root: string) => write(root, 'electron.vite.config.ts', "import '../outside.js'\n")]
    ])('make the key null: %s', (_name, change) => {
      const root = withPlugins()
      expect(e2e(root)).not.toBeNull()
      change(root)
      expect(e2e(root)).toBeNull()
    })
  })

  describe('isUnitTest', () => {
    it.each([
      'src/main/tests/omnibox.test.ts',
      'src/shim/wasi-p2/tests/fixtures/tour.generated.json',
      'src/x/__tests__/y.ts',
      'src/deep/er/tests/a/b/c.ts',
      'src/main/old.test.mjs',
      'src/main/spec.test.tsx',
      'tests/top.ts'
    ])('holds for %s', (path) => {
      expect(isUnitTest(path)).toBe(true)
    })

    it.each([
      'src/main/index.ts',
      'src/main/attests/seal.ts',
      'src/main/contests/x.ts',
      'src/main/testing/x.ts',
      'src/main/store-test-hook.ts',
      'src/main/latest.ts',
      'src/main/tests.ts',
      'src/main/x.test.json',
      'src/main/mytest.ts'
    ])('does not hold for %s', (path) => {
      expect(isUnitTest(path)).toBe(false)
    })
  })
})
