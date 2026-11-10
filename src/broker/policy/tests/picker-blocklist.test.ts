import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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

// macOS keeps the account's temporary folder at /var/folders, and /var is a symlink to /private/var, so a file
// made there realpaths into a system folder. The pick is realpath'd before it is checked, so these hand the guard
// the realpath'd form a real pick has.
describe('the account\'s own temporary folder under a system folder', () => {
  const macRealpath = (p: string): string => (p === '/var' || p.startsWith('/var/') ? `/private${p}` : p)
  const MAC: PickerGuardRoots = {
    dataRoots: ['/Users/me/Library/Application Support/Orivon'],
    home: '/Users/me',
    systemDirectories: ['/etc', '/var', '/private', '/Library'],
    privateSessions: { tempDir: '/var/folders/ab/xyz/T', isPrivateDirName: (name) => /^orivon-private-[a-z0-9]{6}$/.test(name) }
  }

  it('allows a file or a folder made there', () => {
    expect(pickerBlockReason('/private/var/folders/ab/xyz/T/orivon-picked-1a2b3c/notes.txt', MAC, macRealpath)).toBeNull()
    expect(pickerBlockReason('/private/var/folders/ab/xyz/T/orivon-picked-1a2b3c', MAC, macRealpath)).toBeNull()
  })

  it('still refuses the rest of the system folder, the temporary folder itself, and a private session inside it', () => {
    expect(pickerBlockReason('/private/var/db/dslocal', MAC, macRealpath)).toBe('this is a system folder')
    expect(pickerBlockReason('/private/var/folders/ab/xyz/C/cache', MAC, macRealpath)).toBe('this is a system folder')
    expect(pickerBlockReason('/private/etc/hosts', MAC, macRealpath)).toBe('this is a system folder')
    expect(pickerBlockReason('/private/var/folders/ab/xyz/T', MAC, macRealpath)).not.toBeNull()
    expect(pickerBlockReason('/private/var/folders/ab/xyz/T/orivon-private-ab12cd', MAC, macRealpath)).not.toBeNull()
  })

  it('refuses everything under a system folder when the guard names no temporary folder', () => {
    const bare: PickerGuardRoots = { dataRoots: MAC.dataRoots, home: MAC.home, systemDirectories: MAC.systemDirectories }
    expect(pickerBlockReason('/private/var/folders/ab/xyz/T/orivon-picked-1a2b3c/notes.txt', bare, macRealpath)).toBe('this is a system folder')
  })

  it('opens nothing for a temporary folder that is a filesystem root or holds a system folder', () => {
    const tempAt = (tempDir: string): PickerGuardRoots => ({ ...MAC, privateSessions: { tempDir, isPrivateDirName: () => false } })
    expect(pickerBlockReason('/etc/hosts', tempAt('/'), identityRealpath)).toBe('this is a system folder')
    expect(pickerBlockReason('/private/var/lib/data', tempAt('/var'), macRealpath)).toBe('this is a system folder')
    expect(pickerBlockReason('/etc/ssh/config', tempAt('/etc'), identityRealpath)).toBe('this is a system folder')
  })

  describe('through a real symlink on this disk', () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orivon-blocklist-')))
    afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })
    mkdirSync(join(scratch, 'private', 'var', 'folders', 'T', 'pick'), { recursive: true })
    mkdirSync(join(scratch, 'private', 'var', 'db'), { recursive: true })
    symlinkSync('private/var', join(scratch, 'var'))
    const guard: PickerGuardRoots = {
      dataRoots: [],
      home: undefined,
      systemDirectories: [join(scratch, 'var'), join(scratch, 'private')],
      privateSessions: { tempDir: join(scratch, 'var', 'folders', 'T'), isPrivateDirName: () => false }
    }

    it('allows a pick that is in the temporary folder, spelled through the link or not', () => {
      expect(pickerBlockReason(realpathSync(join(scratch, 'var', 'folders', 'T', 'pick')), guard, realpathSync)).toBeNull()
      expect(pickerBlockReason(join(scratch, 'private', 'var', 'folders', 'T', 'pick'), guard, realpathSync)).toBeNull()
    })

    it('refuses a pick in the system folder beside it, spelled through the link or not', () => {
      expect(pickerBlockReason(realpathSync(join(scratch, 'var', 'db')), guard, realpathSync)).toBe('this is a system folder')
      expect(pickerBlockReason(join(scratch, 'private', 'var', 'db'), guard, realpathSync)).toBe('this is a system folder')
    })
  })
})
