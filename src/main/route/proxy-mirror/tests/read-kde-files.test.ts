import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { kdeConfigDirectories, nodeFileSystem, readKdeSettings } from '../read-kde-files.js'
import type { KdeFileSystem } from '../read-kde-files.js'
import { READ_TIMEOUT_MS } from '../run-readers.js'

const none = { modifiedAt: async (): Promise<number | undefined> => await Promise.resolve(undefined) }
const settingsOf = (...lines: string[]): string => `[Proxy Settings]\nProxyType=1\n${lines.join('\n')}\n`

/** A file system of these files, each changed at the time given (default 1). */
function files (contents: Record<string, string | { text: string, at: number }>): KdeFileSystem & { readonly opened: string[] } {
  const opened: string[] = []
  const at = (path: string): number | undefined => {
    const one = contents[path]
    return one === undefined ? undefined : typeof one === 'string' ? 1 : one.at
  }
  return {
    opened,
    read: async (path) => {
      opened.push(path)
      const one = contents[path]
      return await Promise.resolve(one === undefined ? undefined : typeof one === 'string' ? one : one.text)
    },
    modifiedAt: async (path) => await Promise.resolve(at(path))
  }
}

describe('where Chromium reads KDE\'s proxy settings', () => {
  const HOME = '/home/me'

  it.each([['5'], ['6']])('is ~/.config for KDE %s, whatever XDG_CONFIG_HOME says', async (version) => {
    const env = { XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: version, HOME, XDG_CONFIG_HOME: '/elsewhere' }
    expect(await kdeConfigDirectories(env, none)).toEqual([`${HOME}/.config`])
  })

  it('adds the XDG_CONFIG_DIRS below ~/.config, the earlier entries above the later, and keeps their spaces as Chromium does', async () => {
    const env = { XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6', HOME, XDG_CONFIG_DIRS: '/etc/xdg::/usr/share/xdg: /spaced' }
    expect(await kdeConfigDirectories(env, none)).toEqual([' /spaced', '/usr/share/xdg', '/etc/xdg', `${HOME}/.config`])
  })

  it('is KDEHOME\'s share/config alone when KDEHOME is set, for every version', async () => {
    expect(await kdeConfigDirectories({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6', HOME, KDEHOME: '/kde' }, none)).toEqual(['/kde/share/config'])
    expect(await kdeConfigDirectories({ KDE_FULL_SESSION: 'true', KDEHOME: '/kde' }, none)).toEqual(['/kde/share/config'])
  })

  it('is ~/.kde for KDE 3, and for KDE 4 the newer of ~/.kde and ~/.kde4', async () => {
    const three = { DESKTOP_SESSION: 'kde', HOME }
    const four = { XDG_CURRENT_DESKTOP: 'KDE', HOME }
    expect(await kdeConfigDirectories(three, none)).toEqual([`${HOME}/.kde/share/config`])
    expect(await kdeConfigDirectories(four, none)).toEqual([`${HOME}/.kde/share/config`])
    const older = `${HOME}/.kde/share/config`
    const newer = `${HOME}/.kde4/share/config`
    expect(await kdeConfigDirectories(four, files({ [older]: { text: '', at: 1 }, [newer]: { text: '', at: 2 } }))).toEqual([newer])
    expect(await kdeConfigDirectories(four, files({ [older]: { text: '', at: 3 }, [newer]: { text: '', at: 2 } }))).toEqual([older])
    expect(await kdeConfigDirectories(four, files({ [newer]: { text: '', at: 2 } }))).toEqual([newer])
    expect(await kdeConfigDirectories(four, files({ [older]: { text: '', at: 2 }, [newer]: { text: '', at: 2 } }))).toEqual([newer])
    expect(await kdeConfigDirectories(three, files({ [older]: { text: '', at: 1 }, [newer]: { text: '', at: 2 } }))).toEqual([older])
  })

  it('is nowhere without a home to look in, and for a desktop that is not KDE', async () => {
    expect(await kdeConfigDirectories({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }, none)).toBeUndefined()
    expect(await kdeConfigDirectories({ XDG_CURRENT_DESKTOP: 'GNOME', HOME }, none)).toBeUndefined()
  })
})

describe('reading KDE\'s proxy settings', () => {
  const env = { XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6', HOME: '/home/me', XDG_CONFIG_DIRS: '/etc/xdg' }

  it('merges the files that exist, the one in the home on top, and opens kioslaverc in each directory', async () => {
    const system = files({
      '/etc/xdg/kioslaverc': settingsOf('httpProxy=127.0.0.1:1111', 'httpsProxy=127.0.0.1:3129'),
      '/home/me/.config/kioslaverc': settingsOf('httpProxy=127.0.0.1:3128')
    })
    expect(await readKdeSettings(env, system)).toMatchObject({ kind: 'manual', proxyRules: 'http=127.0.0.1:3128;https=127.0.0.1:3129' })
    expect(system.opened.sort()).toEqual(['/etc/xdg/kioslaverc', '/home/me/.config/kioslaverc'])
  })

  it('is no proxy when no file is there, since KDE then has no proxy settings', async () => {
    expect(await readKdeSettings(env, files({}))).toEqual({ kind: 'none' })
  })

  it('is unreadable when there is no home to look in, or a read fails', async () => {
    expect(await readKdeSettings({ XDG_CURRENT_DESKTOP: 'KDE' }, files({}))).toEqual({ kind: 'unreadable' })
    expect(await readKdeSettings(env, { ...files({}), read: async () => await Promise.reject(new Error('the settings file is too large')) })).toEqual({ kind: 'unreadable' })
  })

  it('is unreadable when a read takes longer than the bound', async () => {
    vi.useFakeTimers()
    try {
      const reading = readKdeSettings(env, { ...files({}), read: async () => await new Promise<string | undefined>(() => {}) })
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS)
      expect(await reading).toEqual({ kind: 'unreadable' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('opening a settings file', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'orivon-kde-files-'))
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

  it('gives the text of a file, and nothing for a file that is not there or cannot be read as one', async () => {
    writeFileSync(join(scratch, 'kioslaverc'), 'text\n')
    mkdirSync(join(scratch, 'a-directory'))
    expect(await nodeFileSystem.read(join(scratch, 'kioslaverc'))).toBe('text\n')
    expect(await nodeFileSystem.read(join(scratch, 'missing'))).toBeUndefined()
    expect(await nodeFileSystem.read(join(scratch, 'a-directory'))).toBeUndefined()
  })

  it('refuses a file of more than a megabyte', async () => {
    writeFileSync(join(scratch, 'large'), Buffer.alloc(1_048_577, 0x61))
    await expect(nodeFileSystem.read(join(scratch, 'large'))).rejects.toThrow('too large')
  })

  it('says when a file or directory was last changed, and nothing for one that is not there', async () => {
    utimesSync(join(scratch, 'kioslaverc'), 1_000, 1_000)
    expect(await nodeFileSystem.modifiedAt(join(scratch, 'kioslaverc'))).toBe(1_000_000)
    expect(await nodeFileSystem.modifiedAt(join(scratch, 'missing'))).toBeUndefined()
  })
})
