// isShimSource backs both electron.vite.config.ts's isShimImporter and
// vitest.config.ts's own use of it -- exercised here directly, with a
// caller-chosen `root`, so a checkout whose own path happens to contain a
// `tests` or `src/shim` segment can be simulated without actually moving
// the repository on disk.

import { describe, expect, it } from 'vitest'
import { isShimSource } from '../is-shim-source.js'

const ORDINARY_ROOT = '/home/user/git/orivon-mvp'

describe('isShimSource', () => {
  it('is true only for a file under src/shim/, never its own tests', () => {
    expect(isShimSource(ORDINARY_ROOT, `${ORDINARY_ROOT}/src/shim/wasi/fds.ts`)).toBe(true)
    expect(isShimSource(ORDINARY_ROOT, `${ORDINARY_ROOT}/src/shim/wasi/tests/fds.test.ts`)).toBe(false)
    expect(isShimSource(ORDINARY_ROOT, `${ORDINARY_ROOT}/src/preload/child-host.ts`)).toBe(false)
    expect(isShimSource(ORDINARY_ROOT, undefined)).toBe(false)
  })

  it('is false for the bundler plugin, which runs in the build tool\'s Node', () => {
    expect(isShimSource(ORDINARY_ROOT, `${ORDINARY_ROOT}/src/shim/bundler/esbuild-plugin.ts`)).toBe(false)
  })

  it('checks more than one root-relative directory when given one', () => {
    const dirs = ['src/shim/', 'src/shim-electron/']
    expect(isShimSource(ORDINARY_ROOT, `${ORDINARY_ROOT}/src/shim-electron/unimplemented.ts`, dirs)).toBe(true)
    expect(isShimSource(ORDINARY_ROOT, `${ORDINARY_ROOT}/src/shim-electron/tests/unimplemented.test.ts`, dirs)).toBe(false)
  })

  it('normalises a Windows-style backslash root and importer the same way', () => {
    const root = 'C:\\repo'
    expect(isShimSource(root, 'C:\\repo\\src\\shim\\wasi\\fds.ts')).toBe(true)
    expect(isShimSource(root, 'C:\\repo\\src\\shim\\wasi\\tests\\fds.test.ts')).toBe(false)
  })

  // The bug this file exists to fix: the old implementation substring-searched
  // the raw absolute path for '/src/shim/' and '/tests/', so a checkout whose
  // own ancestry (outside the repository) happened to contain either segment
  // name misclassified every file in the repo, not just the ones actually
  // under src/shim/ or under one of its own tests/ directories.
  describe('a checkout root that itself contains a `tests` segment', () => {
    const root = '/home/user/tests/orivon-mvp'

    it('still recognises a real shim module as one', () => {
      expect(isShimSource(root, `${root}/src/shim/wasi/fds.ts`)).toBe(true)
    })

    it('still excludes that module\'s own tests', () => {
      expect(isShimSource(root, `${root}/src/shim/wasi/tests/fds.test.ts`)).toBe(false)
    })

    it('still excludes a file outside src/shim/ entirely', () => {
      expect(isShimSource(root, `${root}/src/preload/child-host.ts`)).toBe(false)
    })
  })

  describe('a checkout root that itself contains a `src/shim` segment', () => {
    const root = '/home/user/src/shim/orivon-mvp'

    it('still recognises a real shim module as one', () => {
      expect(isShimSource(root, `${root}/src/shim/wasi/fds.ts`)).toBe(true)
    })

    it('still excludes a file outside this repository\'s own src/shim/', () => {
      expect(isShimSource(root, `${root}/src/preload/child-host.ts`)).toBe(false)
    })
  })
})
