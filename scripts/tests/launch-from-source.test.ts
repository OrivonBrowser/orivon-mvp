import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PACKAGE_PROGRAM, SOURCE_PROGRAM } from '../../src/main/launch/program-names.js'
import { dataHome, desktopEntry, isRunning, refreshEntry, SOURCE_WINDOW_CLASS } from '../launch-from-source.mjs'

describe('isRunning', () => {
  const BINARY = '/src/orivon/node_modules/electron/dist/electron'
  const exes: Record<string, string> = { 1: '/usr/lib/systemd/systemd', 40: '/usr/bin/bash', 77: BINARY }
  const exeOf = (pid: string): string => {
    const exe = exes[pid]
    if (exe === undefined) throw new Error('EACCES')
    return exe
  }

  it('is true when a process runs this checkout\'s binary, whichever profile or session it is', () => {
    expect(isRunning(BINARY, { pids: () => ['1', 'self', '40', '77'], exeOf })).toBe(true)
  })

  it('counts a binary replaced on disk while it runs', () => {
    expect(isRunning(BINARY, { pids: () => ['9'], exeOf: () => `${BINARY} (deleted)` })).toBe(true)
  })

  it('is false for another checkout\'s binary, a process it may not read, and a system with no /proc', () => {
    expect(isRunning('/other/node_modules/electron/dist/electron', { pids: () => ['1', '40', '77'], exeOf })).toBe(false)
    expect(isRunning(BINARY, { pids: () => ['1', '2'], exeOf })).toBe(false)
    expect(isRunning(BINARY, { pids: () => { throw new Error('ENOENT') }, exeOf })).toBe(false)
  })
})

describe('dataHome', () => {
  it('is $XDG_DATA_HOME when absolute, and ~/.local/share otherwise, as the browser reads it back', () => {
    expect(dataHome({ XDG_DATA_HOME: '/data' }, '/home/a')).toBe('/data')
    expect(dataHome({ XDG_DATA_HOME: 'relative/data' }, '/home/a')).toBe('/home/a/.local/share')
    expect(dataHome({}, '/home/a')).toBe('/home/a/.local/share')
  })
})

describe('desktopEntry', () => {
  const entry = desktopEntry('/usr/bin/node', '/src/orivon/scripts/launch-from-source.mjs', '/src/orivon')

  it('starts the launcher with the addresses, and offers the installed package\'s two actions', () => {
    expect(entry).toContain('Name=Orivon (source)\n')
    expect(entry).toContain('Exec=/usr/bin/node /src/orivon/scripts/launch-from-source.mjs run %U\n')
    expect(entry).toContain('Actions=new-window;new-private-window;\n')
    expect(entry).toContain('[Desktop Action new-window]\nName=New Window\nExec=/usr/bin/node /src/orivon/scripts/launch-from-source.mjs run --new-window\n')
    expect(entry).toContain('[Desktop Action new-private-window]\nName=New Private Window\nExec=/usr/bin/node /src/orivon/scripts/launch-from-source.mjs run --new-private-window\n')
    expect(entry).toContain('Icon=/src/orivon/build/icon-source.png\n')
  })

  it('claims the windows a run from source makes, and never the installed package\'s', () => {
    expect(SOURCE_WINDOW_CLASS).toBe(SOURCE_PROGRAM)
    expect(entry).toContain(`StartupWMClass=${SOURCE_PROGRAM}\n`)
    const packaged = readFileSync(join(import.meta.dirname, '..', '..', 'electron-builder.yml'), 'utf8').match(/^\s*StartupWMClass:\s*(\S+)/m)?.[1]
    expect(packaged).toBe(PACKAGE_PROGRAM)
    expect(SOURCE_PROGRAM).not.toBe(packaged)
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { name: string, desktopName: string }
    expect([pkg.name, pkg.desktopName]).toEqual([PACKAGE_PROGRAM, `${PACKAGE_PROGRAM}.desktop`])
  })

  it('names the program unquoted, as xdg-settings reads it, and lists the web types in the main group', () => {
    expect(entry).not.toContain('"')
    const main = entry.split('\n\n')[0] as string
    expect(main).toContain('MimeType=text/html;application/xhtml+xml;image/svg+xml;application/pdf;x-scheme-handler/http;x-scheme-handler/https;\n')
  })

  it('refuses a path the entry would have to escape', () => {
    for (const root of ['/my src/orivon', '/src/"o"', '/src/$HOME', '/src/100%', '/src/a\\b', '/src/a\nExec=x', '/src/a;b', '/src/(a)', '/src/~a']) {
      expect(() => desktopEntry('/usr/bin/node', `${root}/scripts/launch-from-source.mjs`, root)).toThrow(/cannot name/)
    }
  })
})

describe('refreshEntry', () => {
  const script = '/src/orivon/scripts/launch-from-source.mjs'
  const entry = desktopEntry('/usr/bin/node', script, '/src/orivon')
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-entry-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('rewrites an entry of this checkout that an older checkout wrote', () => {
    const path = join(dir, 'orivon-source.desktop')
    writeFileSync(path, entry.replace(`StartupWMClass=${SOURCE_PROGRAM}`, 'StartupWMClass=orivon'))
    expect(refreshEntry(path, entry, script)).toBe('refreshed')
    expect(readFileSync(path, 'utf8')).toBe(entry)
    expect(refreshEntry(path, entry, script)).toBe('current')
  })

  it('never creates an entry, nor touches one that starts another checkout', () => {
    const path = join(dir, 'orivon-source.desktop')
    expect(refreshEntry(path, entry, script)).toBe('absent')
    writeFileSync(path, entry.replaceAll('/src/orivon', '/elsewhere/orivon'))
    expect(refreshEntry(path, entry, script)).toBe('other')
    expect(readFileSync(path, 'utf8')).toContain('/elsewhere/orivon')
  })
})
