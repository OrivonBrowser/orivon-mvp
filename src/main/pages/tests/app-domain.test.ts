import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../internal-ipc.js'
import { appDomain } from '../app-domain.js'

const CALLER = {} as InternalCaller

describe('the app domain', () => {
  it('starts the app again, through a quit that lets the stores flush', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn() }
    expect(appDomain(app, false).handle({ type: 'relaunch' }, CALLER)).toEqual({ ok: true })
    expect(app.relaunch).toHaveBeenCalledTimes(1)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('does not, in a private session, which cannot be started again', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn() }
    expect(appDomain(app, true).handle({ type: 'relaunch' }, CALLER)).toEqual({ ok: false, reason: 'private' })
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('is for Settings only, and does nothing else', () => {
    const app = { relaunch: vi.fn(), quit: vi.fn() }
    const domain = appDomain(app, false)
    expect(domain.pages).toEqual(['settings'])
    expect(domain.handle({ type: 'exit' }, CALLER)).toBeUndefined()
    expect(domain.handle(null, CALLER)).toBeUndefined()
    expect(app.quit).not.toHaveBeenCalled()
  })
})
