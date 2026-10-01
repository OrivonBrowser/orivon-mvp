import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import type { DefaultBrowserHost } from '../default-browser.js'
import { osDomain } from '../os-domain.js'

const CALLER = {} as InternalCaller

function host (packaged: boolean): DefaultBrowserHost & { setDefault: ReturnType<typeof vi.fn> } {
  let registered = false
  return { isPackaged: packaged, appImage: false, isDefault: () => registered, setDefault: vi.fn(() => { registered = true; return true }) }
}

describe('the os domain', () => {
  it('is for Settings only', () => {
    expect(osDomain(host(true), false, async () => {}).pages).toEqual(['settings'])
  })

  it('reports the state, and makes Orivon the default when packaged', async () => {
    const h = host(true)
    const domain = osDomain(h, false, async () => {})
    expect(await domain.handle({ type: 'defaultBrowser' }, CALLER)).toEqual({ state: 'can-set' })
    expect(await domain.handle({ type: 'makeDefault' }, CALLER)).toEqual({ state: 'default', ok: true })
    expect(await domain.handle({ type: 'defaultBrowser' }, CALLER)).toEqual({ state: 'default' })
  })

  it('never registers an unpackaged run', async () => {
    const h = host(false)
    expect(await osDomain(h, false, async () => {}).handle({ type: 'makeDefault' }, CALLER)).toEqual({ state: 'unavailable', ok: false })
    expect(h.setDefault).not.toHaveBeenCalled()
  })

  it('answers "unavailable" to a private session and registers nothing', async () => {
    const h = host(true)
    const domain = osDomain(h, true, async () => {})
    expect(await domain.handle({ type: 'defaultBrowser' }, CALLER)).toEqual({ state: 'unavailable', ok: false })
    expect(await domain.handle({ type: 'makeDefault' }, CALLER)).toEqual({ state: 'unavailable', ok: false })
    expect(h.setDefault).not.toHaveBeenCalled()
  })

  it('answers nothing else', async () => {
    const domain = osDomain(host(true), false, async () => {})
    for (const bad of [{ type: 'quit' }, { type: 3 }, {}, null, 'makeDefault', undefined]) expect(await domain.handle(bad, CALLER)).toBeUndefined()
  })
})
