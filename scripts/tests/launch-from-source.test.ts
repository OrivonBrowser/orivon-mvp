import { describe, expect, it } from 'vitest'
import { desktopEntry, isOpen, lockPid, userDataDir } from '../launch-from-source.mjs'

describe('lockPid', () => {
  it('reads the pid of a lock this host holds, with a dash in the host name', () => {
    expect(lockPid('my-laptop-4242', 'my-laptop')).toBe(4242)
  })

  it('ignores a lock another host holds, and a link that names no pid', () => {
    expect(lockPid('other-4242', 'my-laptop')).toBeNull()
    expect(lockPid('my-laptop-', 'my-laptop')).toBeNull()
    expect(lockPid('my-laptop-x1', 'my-laptop')).toBeNull()
    expect(lockPid('4242', 'my-laptop')).toBeNull()
  })
})

describe('userDataDir', () => {
  it('is the app name under the config home, the XDG one when set', () => {
    expect(userDataDir([], {}, '/home/a', 'orivon')).toBe('/home/a/.config/orivon')
    expect(userDataDir(['--new-window'], { XDG_CONFIG_HOME: '/cfg' }, '/home/a', 'orivon')).toBe('/cfg/orivon')
  })

  it('is the directory --user-data-dir= names, unless it follows --', () => {
    expect(userDataDir(['--user-data-dir=/d'], {}, '/home/a', 'orivon')).toBe('/d')
    expect(userDataDir(['--', '--user-data-dir=/d'], {}, '/home/a', 'orivon')).toBe('/home/a/.config/orivon')
  })
})

describe('isOpen', () => {
  const lock = (target: string) => (path: string): string => {
    expect(path).toBe('/d/SingletonLock')
    return target
  }

  it('is true when this host holds the lock and its process is alive', () => {
    expect(isOpen('/d', { readLink: lock('host-7'), host: 'host', alive: () => true })).toBe(true)
  })

  it('is false for a lock a crash left behind, one of another host, and no lock at all', () => {
    expect(isOpen('/d', { readLink: lock('host-7'), host: 'host', alive: () => false })).toBe(false)
    expect(isOpen('/d', { readLink: lock('other-7'), host: 'host', alive: () => true })).toBe(false)
    expect(isOpen('/d', { readLink: () => { throw new Error('ENOENT') }, host: 'host', alive: () => true })).toBe(false)
  })
})

describe('desktopEntry', () => {
  const entry = desktopEntry('/usr/bin/node', '/src/orivon/scripts/launch-from-source.mjs', '/src/orivon')

  it('starts the launcher with the addresses, and offers the installed package\'s two actions', () => {
    expect(entry).toContain('Name=Orivon (source)\n')
    expect(entry).toContain('Exec="/usr/bin/node" "/src/orivon/scripts/launch-from-source.mjs" run %U\n')
    expect(entry).toContain('Actions=new-window;new-private-window;\n')
    expect(entry).toContain('[Desktop Action new-window]\nName=New Window\nExec="/usr/bin/node" "/src/orivon/scripts/launch-from-source.mjs" run --new-window\n')
    expect(entry).toContain('[Desktop Action new-private-window]\nName=New Private Window\nExec="/usr/bin/node" "/src/orivon/scripts/launch-from-source.mjs" run --new-private-window\n')
    expect(entry).toContain('Icon=/src/orivon/build/icon.png\n')
    expect(entry).toContain('StartupWMClass=orivon\n')
  })

  it('refuses a path the entry would have to escape', () => {
    for (const root of ['/my src/orivon', '/src/"o"', '/src/$HOME', '/src/100%', '/src/a\\b', '/src/a\nExec=x']) {
      expect(() => desktopEntry('/usr/bin/node', `${root}/scripts/launch-from-source.mjs`, root)).toThrow(/cannot name/)
    }
  })
})
