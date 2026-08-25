import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkNoNativeModules } from './check-no-native-modules.mjs'

const fixture = (): string => mkdtempSync(join(tmpdir(), 'orivon-guard-'))

const pkg = (root: string, ...segments: string[]): string => {
  const dir = join(root, 'node_modules', ...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}

const manifest = (dir: string, contents: object): void => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(contents))
}

const CLEAN = { ok: true, offenders: [], prebuilt: [] }

describe('checkNoNativeModules', () => {
  describe('what it must reject: dependencies needing a compiler', () => {
    it('fails on a binding.gyp', () => {
      const root = fixture()
      writeFileSync(join(pkg(root, 'node-datachannel'), 'binding.gyp'), '{}')
      const result = checkNoNativeModules(root)
      expect(result.ok).toBe(false)
      expect(result.offenders).toEqual(['node_modules/node-datachannel/binding.gyp'])
    })

    it('fails on a prebuilds directory', () => {
      const root = fixture()
      pkg(root, 'bufferutil', 'prebuilds', 'linux-x64')
      const result = checkNoNativeModules(root)
      expect(result.ok).toBe(false)
      expect(result.offenders).toEqual(['node_modules/bufferutil/prebuilds'])
    })

    it.each([
      ['cmake-js', { install: 'cmake-js compile' }],
      ['node-gyp', { install: 'node-gyp rebuild' }],
      ['node-pre-gyp', { postinstall: 'node-pre-gyp install --fallback-to-build' }],
      ['prebuild-install', { install: 'prebuild-install || node-gyp rebuild' }],
      ['cargo', { preinstall: 'cargo build --release' }]
    ])('fails when an install hook invokes %s', (_tool, scripts) => {
      const root = fixture()
      manifest(pkg(root, 'some-native-pkg'), { name: 'some-native-pkg', scripts })
      const result = checkNoNativeModules(root)
      expect(result.ok).toBe(false)
      expect(result.offenders).toEqual(['node_modules/some-native-pkg/package.json'])
    })

    it('finds artefacts nested in transitive dependencies', () => {
      const root = fixture()
      const nested = pkg(root, 'webrtc-polyfill', 'node_modules', 'node-datachannel')
      writeFileSync(join(nested, 'binding.gyp'), '{}')
      const result = checkNoNativeModules(root)
      expect(result.ok).toBe(false)
      expect(result.offenders[0]).toContain('webrtc-polyfill/node_modules/node-datachannel')
    })

    it('reports every offender, not just the first', () => {
      const root = fixture()
      writeFileSync(join(pkg(root, 'a-pkg'), 'binding.gyp'), '{}')
      writeFileSync(join(pkg(root, 'b-pkg'), 'binding.gyp'), '{}')
      expect(checkNoNativeModules(root).offenders).toHaveLength(2)
    })
  })

  describe('what it must NOT reject: prebuilt binaries', () => {
    // Rejecting these would fail on Electron's own dependencies, so the guard
    // would be switched off within a day and protect nothing.
    it('reports a .node binary as prebuilt, not as a failure', () => {
      const root = fixture()
      writeFileSync(join(pkg(root, '@swc', 'core-linux-x64-gnu'), 'swc.linux-x64-gnu.node'), '\x7fELF')
      const result = checkNoNativeModules(root)
      expect(result.ok).toBe(true)
      expect(result.offenders).toEqual([])
      expect(result.prebuilt).toEqual(['node_modules/@swc/core-linux-x64-gnu/swc.linux-x64-gnu.node'])
    })

    it('allows an install hook that does not invoke a compiler', () => {
      const root = fixture()
      manifest(pkg(root, 'friendly-pkg'), {
        name: 'friendly-pkg',
        scripts: { postinstall: 'node ./scripts/print-funding-message.js' }
      })
      expect(checkNoNativeModules(root)).toEqual(CLEAN)
    })

    it('is not fooled by a build tool named outside an install hook', () => {
      const root = fixture()
      manifest(pkg(root, 'dev-only-pkg'), {
        name: 'dev-only-pkg',
        scripts: { build: 'cmake-js compile', test: 'node-gyp rebuild && mocha' }
      })
      expect(checkNoNativeModules(root)).toEqual(CLEAN)
    })
  })

  describe('traversal safety', () => {
    it('passes on a tree with no native artefacts', () => {
      const root = fixture()
      writeFileSync(join(pkg(root, 'pure-js'), 'index.js'), 'export default 1')
      expect(checkNoNativeModules(root)).toEqual(CLEAN)
    })

    it('passes when there is no node_modules at all', () => {
      expect(checkNoNativeModules(fixture())).toEqual(CLEAN)
    })

    it('ignores a binding.gyp outside node_modules', () => {
      const root = fixture()
      pkg(root, 'pure-js')
      mkdirSync(join(root, 'docs'), { recursive: true })
      writeFileSync(join(root, 'docs/binding.gyp'), 'an example quoted in documentation')
      expect(checkNoNativeModules(root)).toEqual(CLEAN)
    })

    it('does not follow symlinked directories out of the tree', () => {
      const root = fixture()
      const outside = fixture()
      writeFileSync(join(outside, 'binding.gyp'), '{}')
      pkg(root, 'linked-pkg')
      symlinkSync(outside, join(root, 'node_modules', 'linked-pkg', 'escape'), 'dir')
      expect(checkNoNativeModules(root)).toEqual(CLEAN)
    })

    it('does not hang on a symlink cycle', () => {
      const root = fixture()
      const dir = pkg(root, 'cyclic')
      symlinkSync(dir, join(dir, 'self'), 'dir')
      expect(checkNoNativeModules(root).ok).toBe(true)
    })

    it('survives an unparseable package.json', () => {
      const root = fixture()
      writeFileSync(join(pkg(root, 'broken-pkg'), 'package.json'), '{ not json')
      expect(checkNoNativeModules(root)).toEqual(CLEAN)
    })
  })
})
