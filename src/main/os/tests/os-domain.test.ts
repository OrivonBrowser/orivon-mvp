import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import type { DefaultBrowserHost, Launcher } from '../default-browser.js'
import { osDomain } from '../os-domain.js'

const CALLER = {} as InternalCaller

function host (launcher: Launcher, platform: NodeJS.Platform = 'linux'): DefaultBrowserHost & { setDefault: ReturnType<typeof vi.fn> } {
  let registered = false
  return { platform, launcher, isDefault: async () => registered, setDefault: vi.fn(() => { registered = true; return true }), openSettings: vi.fn(async () => {}) }
}

describe('the os domain', () => {
  it('is for Settings only', () => {
    expect(osDomain(host('installed'), false, async () => {}).pages).toEqual(['settings'])
  })

  it('reports the state, and makes Orivon the default when installed', async () => {
    const h = host('installed')
    const domain = osDomain(h, false, async () => {})
    expect(await domain.handle({ type: 'defaultBrowser' }, CALLER)).toEqual({ state: 'can-set' })
    expect(await domain.handle({ type: 'makeDefault' }, CALLER)).toEqual({ state: 'default', ok: true, handedOff: false })
    expect(await domain.handle({ type: 'defaultBrowser' }, CALLER)).toEqual({ state: 'default' })
  })

  it('says why a run from source or an AppImage cannot, and never registers it', async () => {
    for (const launcher of ['source', 'appimage'] as const) {
      const h = host(launcher)
      const domain = osDomain(h, false, async () => {})
      expect(await domain.handle({ type: 'defaultBrowser' }, CALLER)).toEqual({ state: 'unavailable', reason: launcher })
      expect(await domain.handle({ type: 'makeDefault' }, CALLER)).toEqual({ state: 'unavailable', reason: launcher, ok: false, handedOff: false })
      expect(h.setDefault).not.toHaveBeenCalled()
    }
  })

  it('reports a hand-over to Windows settings', async () => {
    const domain = osDomain(host('installed', 'win32'), false, async () => {})
    expect(await domain.handle({ type: 'makeDefault' }, CALLER)).toEqual({ state: 'can-set', ok: false, handedOff: true })
  })

  it('answers "unavailable" to a private session and registers nothing', async () => {
    const h = host('installed')
    const domain = osDomain(h, true, async () => {})
    expect(await domain.handle({ type: 'defaultBrowser' }, CALLER)).toEqual({ state: 'unavailable', reason: 'private', ok: false, handedOff: false })
    expect(await domain.handle({ type: 'makeDefault' }, CALLER)).toEqual({ state: 'unavailable', reason: 'private', ok: false, handedOff: false })
    expect(h.setDefault).not.toHaveBeenCalled()
  })

  it('answers nothing else', async () => {
    const domain = osDomain(host('installed'), false, async () => {})
    for (const bad of [{ type: 'quit' }, { type: 3 }, {}, null, 'makeDefault', undefined]) expect(await domain.handle(bad, CALLER)).toBeUndefined()
  })
})
