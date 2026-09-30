import { describe, expect, it } from 'vitest'
import { createPickGuardCheck } from '../capabilities/user-selected.js'
import { baseDeps, stubFs } from './index.test-helpers.js'

// The picker guard's own protected-roots bug: `additionalProtectedRoots` and
// `privateSessionGuard` used to be read ONCE, at broker construction, into a
// closure that never looked again -- a profile or private session created
// later in the same process was never protected. These prove the guard
// `createPickGuardCheck` returns re-asks both on EVERY pick.
describe('createPickGuardCheck recomputes its protected roots at pick time', () => {
  it('protects a profile directory only once additionalProtectedRoots starts reporting it', () => {
    let roots: readonly string[] = []
    const check = createPickGuardCheck(baseDeps({
      fs: stubFs(),
      additionalProtectedRoots: () => roots
    }))

    expect(check('/new/profile')).toBeNull()

    // A profile created mid-session, after this guard function was built.
    roots = ['/new/profile']

    expect(check('/new/profile')).not.toBeNull()
  })

  it('protects a private-session directory only once privateSessionGuard reports its name as taken', () => {
    let started = false
    const check = createPickGuardCheck(baseDeps({
      fs: stubFs(),
      privateSessionGuard: () => ({
        tempDir: '/tmp',
        isPrivateDirName: (name) => started && name === 'orivon-private-ab12cd'
      })
    }))

    expect(check('/tmp/orivon-private-ab12cd')).toBeNull()

    // A private session started mid-session, after this guard was built.
    started = true

    expect(check('/tmp/orivon-private-ab12cd')).not.toBeNull()
  })
})
