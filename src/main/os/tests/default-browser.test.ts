import { describe, expect, it, vi } from 'vitest'
import { defaultBrowserState, makeDefaultBrowser, readDefaultBrowser, SETTLE_MS } from '../default-browser.js'
import type { DefaultBrowserHost } from '../default-browser.js'

const facts = { isPackaged: true, appImage: false, isHttp: false, isHttps: false }

describe('defaultBrowserState', () => {
  it('is unavailable from source and from an AppImage, whatever the system says', () => {
    expect(defaultBrowserState({ ...facts, isPackaged: false })).toBe('unavailable')
    expect(defaultBrowserState({ ...facts, isPackaged: false, isHttp: true, isHttps: true })).toBe('unavailable')
    expect(defaultBrowserState({ ...facts, appImage: true })).toBe('unavailable')
  })

  it('is default only when both web protocols are Orivon\'s', () => {
    expect(defaultBrowserState({ ...facts, isHttp: true, isHttps: true })).toBe('default')
    expect(defaultBrowserState({ ...facts, isHttp: true })).toBe('can-set')
    expect(defaultBrowserState({ ...facts, isHttps: true })).toBe('can-set')
    expect(defaultBrowserState(facts)).toBe('can-set')
  })
})

function host (over: Partial<DefaultBrowserHost> & { registered?: { value: boolean } } = {}): DefaultBrowserHost & { isDefault: ReturnType<typeof vi.fn>, setDefault: ReturnType<typeof vi.fn> } {
  const registered = over.registered ?? { value: false }
  return {
    isPackaged: over.isPackaged ?? true,
    appImage: over.appImage ?? false,
    isDefault: vi.fn(() => registered.value),
    setDefault: vi.fn(() => { registered.value = true; return true })
  }
}

describe('readDefaultBrowser', () => {
  it('asks the system nothing where the answer could not be acted on', () => {
    for (const h of [host({ isPackaged: false }), host({ appImage: true })]) {
      expect(readDefaultBrowser(h)).toBe('unavailable')
      expect(h.isDefault).not.toHaveBeenCalled()
    }
  })

  it('reads both protocols when packaged', () => {
    const h = host({ registered: { value: true } })
    expect(readDefaultBrowser(h)).toBe('default')
    expect(h.isDefault).toHaveBeenCalledWith('http')
    expect(h.isDefault).toHaveBeenCalledWith('https')
  })
})

describe('makeDefaultBrowser', () => {
  it('never registers from source or from an AppImage', async () => {
    for (const h of [host({ isPackaged: false }), host({ appImage: true })]) {
      expect(await makeDefaultBrowser(h, async () => {})).toEqual({ state: 'unavailable', ok: false })
      expect(h.setDefault).not.toHaveBeenCalled()
    }
  })

  it('registers http and https, waits, and reads the answer back', async () => {
    const h = host()
    const wait = vi.fn(async () => {})
    expect(await makeDefaultBrowser(h, wait)).toEqual({ state: 'default', ok: true })
    expect(h.setDefault.mock.calls).toEqual([['http'], ['https']])
    expect(wait).toHaveBeenCalledWith(SETTLE_MS)
  })

  it('says so when the system did not take the change', async () => {
    const h = host()
    h.setDefault.mockImplementation(() => false)
    expect(await makeDefaultBrowser(h, async () => {})).toEqual({ state: 'can-set', ok: false })
  })

  it('survives a registration that throws, and still reads the state back', async () => {
    const h = host()
    h.setDefault.mockImplementation(() => { throw new Error('no xdg-settings') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await makeDefaultBrowser(h, async () => {})).toEqual({ state: 'can-set', ok: false })
    log.mockRestore()
  })

  it('does nothing when Orivon already is the default', async () => {
    const h = host({ registered: { value: true } })
    expect(await makeDefaultBrowser(h, async () => {})).toEqual({ state: 'default', ok: true })
    expect(h.setDefault).not.toHaveBeenCalled()
  })
})
