import { describe, expect, it } from 'vitest'
import { electronInstallPlan, resolveInstaller } from '../install-electron.mjs'

/** A resolver that always finds the installer, for the env-var cases. */
const found = (): string => '/somewhere/node_modules/electron/install.js'

/** A resolver standing in for `npm install --omit=dev`. */
const missing = (): undefined => undefined

describe('electronInstallPlan', () => {
  it('installs when nothing opts out and electron is present', () => {
    expect(electronInstallPlan({}, found)).toEqual({
      action: 'install',
      installer: '/somewhere/node_modules/electron/install.js'
    })
  })

  it('skips when ELECTRON_SKIP_BINARY_DOWNLOAD is set', () => {
    expect(electronInstallPlan({ ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }, found))
      .toEqual({ action: 'skip' })
  })

  // An unset variable and one exported as empty must not mean different
  // things: `ELECTRON_SKIP_BINARY_DOWNLOAD=` in a CI matrix is how a skip
  // gets switched off, and it would be read as a skip by a bare truthiness
  // test on the string.
  it('treats an empty value as not set', () => {
    expect(electronInstallPlan({ ELECTRON_SKIP_BINARY_DOWNLOAD: '' }, found).action)
      .toBe('install')
  })

  // The hook runs for `npm install --omit=dev` too, and electron is a
  // devDependency. Failing there would break an install that never wanted the
  // binary in the first place.
  it('reports absent, not a failure, when electron is not installed', () => {
    expect(electronInstallPlan({}, missing)).toEqual({ action: 'absent' })
  })

  it('does not consult the resolver when the skip is set', () => {
    let called = false
    const spy = (): string => { called = true; return 'x' }
    electronInstallPlan({ ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }, spy)
    expect(called).toBe(false)
  })
})

describe('resolveInstaller', () => {
  it('finds electron/install.js in this tree', () => {
    expect(resolveInstaller()).toMatch(/node_modules[/\\]electron[/\\]install\.js$/)
  })

  it('returns undefined rather than throwing when the package is absent', () => {
    expect(resolveInstaller('file:///nowhere/that/exists/x.mjs')).toBeUndefined()
  })
})
