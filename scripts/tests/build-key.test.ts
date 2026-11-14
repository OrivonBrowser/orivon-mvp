import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildKey } from '../build-key.mjs'
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

    it('is null without npm\'s record of the installed packages', () => {
      const root = inputsRepo()
      rmSync(join(root, 'node_modules/.package-lock.json'))
      expect(e2e(root)).toBeNull()
    })

    it('rejects a build kind it does not know', () => {
      expect(() => buildKey(inputsRepo(), 'dev' as 'e2e', {})).toThrow(/unknown build kind/)
    })
  })
})
