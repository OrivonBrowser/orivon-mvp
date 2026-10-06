import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../internal-ipc.js'
import { appDomain } from '../app-domain.js'

const CALLER = {} as InternalCaller

describe('the app domain', () => {
  it('starts the app again, through a quit that lets the stores flush', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn(), isPackaged: true }
    expect(appDomain(app, false).handle({ type: 'relaunch' }, CALLER)).toEqual({ ok: true })
    expect(app.relaunch).toHaveBeenCalledTimes(1)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('keeps the command line\'s switches and drops the address it was started with', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn(), isPackaged: true }
    appDomain(app, false, ['/usr/bin/orivon', '--orivon-profile=work', 'https://x.example/', '--no-sandbox']).handle({ type: 'relaunch' }, CALLER)
    expect(app.relaunch).toHaveBeenCalledWith({ args: ['--orivon-profile=work', '--no-sandbox'] })
  })

  it('drops a file named by its path, which a Windows Open with passes after --', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn(), isPackaged: true }
    appDomain(app, false, ['C:\\Orivon\\Orivon.exe', '--orivon-profile=work', '--', 'C:\\Users\\a\\x.html']).handle({ type: 'relaunch' }, CALLER)
    expect(app.relaunch).toHaveBeenCalledWith({ args: ['--orivon-profile=work'] })
  })

  it('does not, in a private session, which cannot be started again', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn(), isPackaged: true }
    expect(appDomain(app, true).handle({ type: 'relaunch' }, CALLER)).toEqual({ ok: false, reason: 'private' })
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('is for Settings only, and does nothing else', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn(), isPackaged: true }
    const domain = appDomain(app, false)
    expect(domain.pages).toEqual(['settings'])
    expect(domain.handle({ type: 'exit' }, CALLER)).toBeUndefined()
    expect(domain.handle(null, CALLER)).toBeUndefined()
    expect(app.quit).not.toHaveBeenCalled()
  })
})
