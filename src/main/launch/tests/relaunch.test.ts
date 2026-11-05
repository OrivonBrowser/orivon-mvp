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

  it('adds the page to open, last, after the app path of a run from source', () => {
    expect(relaunchArgs(['orivon', '--orivon-profile=a1b2c3d4e5f6', 'https://old.example/'], true, 'https://game.example/play?level=2')).toEqual(['--orivon-profile=a1b2c3d4e5f6', 'https://game.example/play?level=2'])
    expect(relaunchArgs(['electron', '--no-sandbox', 'out/main/index.js'], false, 'https://game.example/')).toEqual(['--no-sandbox', 'out/main/index.js', 'https://game.example/'])
  })

  it.each(['', 'about:blank', 'orivon://settings', 'file:///etc/passwd', 'javascript:alert(1)', '--new-window', '-x', 'not a url'])('adds nothing for %j, which is no web address', (address) => {
    expect(relaunchArgs(['orivon', '--no-sandbox'], true, address)).toEqual(['--no-sandbox'])
  })

  it('writes the page as an address the launch reads back, one operand and never a switch', () => {
    const [page] = relaunchArgs(['orivon'], true, 'https://game.example/a b')
    expect(page).toBe('https://game.example/a%20b')
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
})
