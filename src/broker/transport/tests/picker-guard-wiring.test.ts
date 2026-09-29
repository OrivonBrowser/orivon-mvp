import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { additionalProtectedRoots, privateSessionGuard } from '../picker-guard-wiring.js'

// `additionalProtectedRoots`/`privateSessionGuard` are plain functions of
// `node:os`/`node:path` facts and a stub `app` -- `notifyPickRefused`, the
// one export in this file that touches `electron.dialog`, is untouched
// here, so this runs under plain vitest exactly as
// `picker-dialog-wording.test.ts` does for its own electron-free half.

describe('additionalProtectedRoots', () => {
  it('names the default profile\'s own directory, reconstructed from appData + the app name', () => {
    const app = { getPath: (name: string) => (name === 'appData' ? '/home/user/.config' : ''), getName: () => 'Orivon' }

    expect(additionalProtectedRoots(app)).toEqual(['/home/user/.config/Orivon'])
  })
})

describe('privateSessionGuard', () => {
  it('names the real temp directory and a working isPrivateDirName predicate', () => {
    const guard = privateSessionGuard()

    expect(guard.tempDir).toBe(tmpdir())
    expect(guard.isPrivateDirName('orivon-private-ab12cd')).toBe(true)
    expect(guard.isPrivateDirName('Downloads')).toBe(false)
  })
})
