import { describe, expect, it } from 'vitest'
import { pickerBlockReason } from '../picker-blocklist.js'
import type { PickerGuardRoots } from '../picker-blocklist.js'

// Every path here is realpath'd through `identityRealpath`: nothing is a
// symlink, so `pickerBlockReason` is exercised on its own comparison logic,
// not on the resolution step `paths.test.ts` already covers for
// `confinePath`.
const identityRealpath = (p: string): string => p

const BASE: PickerGuardRoots = {
  dataRoots: ['/home/user/.config/Orivon'],
  home: '/home/user',
  systemDirectories: ['/etc', '/proc', '/sys', '/dev', '/boot', '/run', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/var', '/private', '/Library']
}

describe('pickerBlockReason', () => {
  it('refuses a data root, and a pick that CONTAINS one', () => {
    expect(pickerBlockReason('/home/user/.config/Orivon', BASE, identityRealpath)).not.toBeNull()
    expect(pickerBlockReason('/home/user/.config/Orivon/apps/x', BASE, identityRealpath)).not.toBeNull()
    expect(pickerBlockReason('/home/user/.config', BASE, identityRealpath)).not.toBeNull()
  })

  it('allows an ordinary subfolder of home', () => {
    expect(pickerBlockReason('/home/user/Downloads', BASE, identityRealpath)).toBeNull()
  })

  it('refuses home itself and an ancestor of home', () => {
    expect(pickerBlockReason('/home/user', BASE, identityRealpath)).not.toBeNull()
    expect(pickerBlockReason('/home', BASE, identityRealpath)).not.toBeNull()
  })

  it('refuses a filesystem root', () => {
    expect(pickerBlockReason('/', BASE, identityRealpath)).not.toBeNull()
  })

  for (const dir of ['/proc', '/sys', '/dev', '/boot', '/run', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/var', '/private', '/Library']) {
    it(`refuses the system directory ${dir} and a path inside it`, () => {
      expect(pickerBlockReason(dir, BASE, identityRealpath)).not.toBeNull()
      expect(pickerBlockReason(`${dir}/inner`, BASE, identityRealpath)).not.toBeNull()
    })
  }

  it('refuses /proc/<pid>/mem style paths -- the main process\'s own memory', () => {
    expect(pickerBlockReason('/proc/1234/mem', BASE, identityRealpath)).not.toBeNull()
  })

  describe('private sessions, matched by name rather than by a snapshot', () => {
    const guard: PickerGuardRoots = { ...BASE, privateSessions: { tempDir: '/tmp', isPrivateDirName: (name) => /^orivon-private-[a-z0-9]{6}$/.test(name) } }

    it('refuses a private-session directory that did not exist when the guard was built', () => {
      // Nothing about this guard was told this directory exists -- the rule
      // matches its NAME, not a list captured earlier.
      expect(pickerBlockReason('/tmp/orivon-private-ab12cd', guard, identityRealpath)).not.toBeNull()
    })

    it('refuses a path nested inside a private-session directory', () => {
      expect(pickerBlockReason('/tmp/orivon-private-ab12cd/Default/Cookies', guard, identityRealpath)).not.toBeNull()
    })

    it('refuses the temp directory itself, and an ancestor of it', () => {
      expect(pickerBlockReason('/tmp', guard, identityRealpath)).not.toBeNull()
      expect(pickerBlockReason('/', guard, identityRealpath)).not.toBeNull()
    })

    it('allows a temp-directory sibling that is not shaped like a private session', () => {
      expect(pickerBlockReason('/tmp/some-other-app-cache', guard, identityRealpath)).toBeNull()
    })

    it('is a no-op when the guard carries no privateSessions rule', () => {
      expect(pickerBlockReason('/tmp/orivon-private-ab12cd', BASE, identityRealpath)).toBeNull()
    })
  })
})
