import { describe, expect, it } from 'vitest'
import { electronChanged, electronVersions } from '../electron-version-changed.mjs'

const pkg = (range: string, extra: object = {}): string => JSON.stringify({ name: 'x', devDependencies: { electron: range, ...extra } })
const lock = (version: string): string => JSON.stringify({ packages: { '': {}, 'node_modules/electron': { version } } })

describe('the Electron a branch ships', () => {
  it('reads the range and the resolved version', () => {
    expect(electronVersions(pkg('^44.7.0'), lock('44.7.0'))).toEqual({ range: '^44.7.0', resolved: '44.7.0' })
  })

  it('reads a file that does not say, or cannot be parsed, as undefined', () => {
    expect(electronVersions('{', undefined)).toEqual({ range: undefined, resolved: undefined })
    expect(electronVersions(JSON.stringify({ name: 'x' }), JSON.stringify({ packages: {} }))).toEqual({ range: undefined, resolved: undefined })
  })
})

describe('whether the Electron version changed', () => {
  const base = { packageJson: pkg('^44.7.0'), lockJson: lock('44.7.0') }

  it('is false for the same range and the same resolved version', () => {
    expect(electronChanged(base, { packageJson: pkg('^44.7.0', { vite: '^7' }), lockJson: lock('44.7.0') })).toBe(false)
  })

  it('is true when the range changes', () => {
    expect(electronChanged(base, { packageJson: pkg('^45.0.0'), lockJson: lock('44.7.0') })).toBe(true)
  })

  it('is true when only the lock moves it, which is how a patch upgrade lands', () => {
    expect(electronChanged(base, { packageJson: base.packageJson, lockJson: lock('44.8.1') })).toBe(true)
  })

  it('is false when other packages in the lock change', () => {
    const other = JSON.stringify({ packages: { 'node_modules/electron': { version: '44.7.0' }, 'node_modules/vite': { version: '9' } } })
    expect(electronChanged(base, { packageJson: base.packageJson, lockJson: other })).toBe(false)
  })
})
