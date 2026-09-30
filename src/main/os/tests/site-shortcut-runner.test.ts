import { describe, expect, it, vi } from 'vitest'
import { createShortcut } from '../site-shortcut-runner.js'
import type { ShortcutHost } from '../site-shortcut-runner.js'

interface Written { path: string, options: { target: string, args: string, description: string } }

interface Options {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  isPackaged?: boolean
  writeFile?: ShortcutHost['writeFile']
  writeLink?: ShortcutHost['writeLink']
}

function host (options: Options = {}): ShortcutHost & { files: Map<string, { text: string, mode: number }>, directories: string[], links: Written[] } {
  const files = new Map<string, { text: string, mode: number }>()
  const directories: string[] = []
  const links: Written[] = []
  return {
    platform: options.platform ?? 'linux',
    isPackaged: options.isPackaged ?? true,
    appPath: '/src/orivon',
    execPath: '/opt/Orivon/orivon',
    env: () => options.env ?? {},
    home: () => '/home/ada',
    desktop: () => 'C:\\Users\\ada\\Desktop',
    makeDirectory: async (path) => { directories.push(path) },
    writeFile: options.writeFile ?? (async (path, text, mode) => { files.set(path, { text, mode }) }),
    writeLink: options.writeLink ?? ((path, details) => { links.push({ path, options: details }); return true }),
    files,
    directories,
    links
  }
}

const REQUEST = { name: 'Example', address: 'https://example.com/a' }

describe('creating a shortcut on Linux', () => {
  it('writes a world-readable desktop entry under the data home', async () => {
    const h = host({ env: { XDG_DATA_HOME: '/tmp/data' } })
    expect(await createShortcut(h, REQUEST)).toEqual({ ok: true, where: 'applications' })
    expect(h.directories).toEqual(['/tmp/data/applications'])
    const [path, file] = [...h.files][0] ?? ['', undefined]
    expect(path).toMatch(/^\/tmp\/data\/applications\/orivon-example-com-[0-9a-f]{8}\.desktop$/)
    expect(file?.mode).toBe(0o644)
    expect(file?.text).toContain('Name=Example\n')
    expect(file?.text).toContain('Exec="/opt/Orivon/orivon" "https://example.com/a"\n')
  })

  it('falls back to ~/.local/share when XDG_DATA_HOME is unset, empty or relative', async () => {
    for (const value of [undefined, '', 'relative/path']) {
      const h = host({ env: { XDG_DATA_HOME: value } })
      await createShortcut(h, REQUEST)
      expect(h.directories, String(value)).toEqual(['/home/ada/.local/share/applications'])
    }
  })

  it('launches the AppImage itself when run from one', async () => {
    const h = host({ env: { XDG_DATA_HOME: '/d', APPIMAGE: '/home/ada/Apps/Orivon.AppImage' } })
    await createShortcut(h, REQUEST)
    expect([...h.files.values()][0]?.text).toContain('Exec="/home/ada/Apps/Orivon.AppImage" "https://example.com/a"')
  })

  it('launches the Electron binary with the app beside it when run from source', async () => {
    const h = host({ isPackaged: false, env: { XDG_DATA_HOME: '/d' } })
    await createShortcut(h, REQUEST)
    expect([...h.files.values()][0]?.text).toContain('Exec="/opt/Orivon/orivon" "/src/orivon" "https://example.com/a"')
  })

  it('names the profile when asked to', async () => {
    const h = host({ env: { XDG_DATA_HOME: '/d' } })
    await createShortcut(h, { ...REQUEST, profileId: '0123456789ab' })
    expect([...h.files.values()][0]?.text).toContain('"--orivon-profile=0123456789ab" "https://example.com/a"')
  })

  it('reports a write that fails, and does not throw', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = host({ env: { XDG_DATA_HOME: '/d' }, writeFile: async () => { throw new Error('read-only file system') } })
    expect(await createShortcut(h, REQUEST)).toEqual({ ok: false, reason: 'failed' })
    log.mockRestore()
  })

  it('refuses an address that cannot be written safely', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = host({ env: { XDG_DATA_HOME: '/d' } })
    expect(await createShortcut(h, { ...REQUEST, address: 'https://example.com/\nExec=/bin/sh' })).toEqual({ ok: false, reason: 'failed' })
    expect(h.files.size).toBe(0)
    log.mockRestore()
  })
})

describe('creating a shortcut on Windows', () => {
  it('writes a link on the desktop with the target, the quoted arguments and the name', async () => {
    const h = host({ platform: 'win32' })
    expect(await createShortcut(h, { ...REQUEST, profileId: '0123456789ab' })).toEqual({ ok: true, where: 'desktop' })
    expect(h.links).toEqual([{ path: 'C:\\Users\\ada\\Desktop/Example.lnk', options: { target: '/opt/Orivon/orivon', args: '"--orivon-profile=0123456789ab" "https://example.com/a"', description: 'Example' } }])
    expect(h.files.size).toBe(0)
  })

  it('reports a link the system would not write', async () => {
    const h = host({ platform: 'win32', writeLink: () => false })
    expect(await createShortcut(h, REQUEST)).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('creating a shortcut elsewhere', () => {
  it('does nothing on macOS', async () => {
    const h = host({ platform: 'darwin' })
    expect(await createShortcut(h, REQUEST)).toEqual({ ok: false, reason: 'unsupported' })
    expect(h.files.size + h.links.length + h.directories.length).toBe(0)
  })
})
