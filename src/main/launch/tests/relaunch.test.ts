import { describe, expect, it, vi } from 'vitest'
import { relaunchArgs, restartOrivon } from '../relaunch.js'

describe('relaunchArgs', () => {
  it('keeps the switches and drops every address and file the process started with', () => {
    expect(relaunchArgs(['/usr/bin/orivon', '--orivon-profile=a1b2c3d4e5f6', 'https://x.example/', '--no-sandbox', '--new-window'], true)).toEqual(['--orivon-profile=a1b2c3d4e5f6', '--no-sandbox'])
    expect(relaunchArgs(['orivon.exe', '--', 'C:\\Users\\a\\x.html'], true)).toEqual([])
  })

  it('keeps the app path of a run from source', () => {
    expect(relaunchArgs(['electron', '--no-sandbox', 'out/main/index.js', 'https://x.example/'], false)).toEqual(['--no-sandbox', 'out/main/index.js'])
  })

  it('adds the site to open, last, after the app path of a run from source', () => {
    expect(relaunchArgs(['orivon', '--orivon-profile=a1b2c3d4e5f6', 'https://old.example/'], true, 'https://game.example/play')).toEqual(['--orivon-profile=a1b2c3d4e5f6', 'https://game.example/'])
    expect(relaunchArgs(['electron', '--no-sandbox', 'out/main/index.js'], false, 'https://game.example/')).toEqual(['--no-sandbox', 'out/main/index.js', 'https://game.example/'])
  })

  it.each(['', 'about:blank', 'orivon://settings', 'file:///etc/passwd', 'javascript:alert(1)', '--new-window', '-x', 'not a url'])('adds nothing for %j, which is no web address', (address) => {
    expect(relaunchArgs(['orivon', '--no-sandbox'], true, address)).toEqual(['--no-sandbox'])
  })

  it('names the site by its origin alone, so no path, query, fragment or sign-in reaches a command line other users can read', () => {
    expect(relaunchArgs(['orivon'], true, 'https://game.example/invite/9f8e7d6c5b4a?token=abc123&room=7#session=xyz')).toEqual(['https://game.example/'])
    expect(relaunchArgs(['orivon'], true, 'https://game.example/magic-link/abc123')).toEqual(['https://game.example/'])
    expect(relaunchArgs(['orivon'], true, 'https://user:secret@game.example:8443/play?x=1')).toEqual(['https://game.example:8443/'])
    expect(relaunchArgs(['orivon'], true, 'http://game.example/?#')).toEqual(['http://game.example/'])
  })

  it('writes the site as an address the launch reads back, one operand and never a switch', () => {
    const [page] = relaunchArgs(['orivon'], true, 'https://b\u00fccher.example/a b')
    expect(page).toBe('https://xn--bcher-kva.example/')
  })
})

describe('restartOrivon', () => {
  it('starts the app again with that command line and ends this process through a quit', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn(), isPackaged: true }
    restartOrivon(app, ['orivon', '--no-sandbox', 'https://old.example/'], 'https://game.example/')
    expect(app.relaunch).toHaveBeenCalledWith({ args: ['--no-sandbox', 'https://game.example/'] })
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('opens no page when none is named', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn(), isPackaged: true }
    restartOrivon(app, ['orivon', 'https://old.example/'])
    expect(app.relaunch).toHaveBeenCalledWith({ args: [] })
  })

  it('runs the AppImage itself, not the program inside the mount that goes away when this process ends', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn(), isPackaged: true }
    restartOrivon(app, ['/tmp/.mount_Orivon1a2b3c/orivon', '--no-sandbox'], undefined, { APPIMAGE: '/home/person/Orivon.AppImage' })
    expect(app.relaunch).toHaveBeenCalledWith({ args: ['--no-sandbox'], execPath: '/home/person/Orivon.AppImage' })
  })

  it('names no program outside an AppImage, so the process starts the one it is', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn(), isPackaged: true }
    restartOrivon(app, ['/opt/Orivon/orivon'], undefined, { APPIMAGE: '' })
    restartOrivon(app, ['/opt/Orivon/orivon'], undefined, {})
    expect(app.relaunch.mock.calls).toEqual([[{ args: [] }], [{ args: [] }]])
  })

  it('names no program for a run from source, whatever the environment holds', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn(), isPackaged: false }
    restartOrivon(app, ['electron', 'out/main/index.js'], undefined, { APPIMAGE: '/ignored.AppImage' })
    expect(app.relaunch).toHaveBeenCalledWith({ args: ['out/main/index.js'] })
  })
})
