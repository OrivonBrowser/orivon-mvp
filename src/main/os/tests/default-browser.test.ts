import { describe, expect, it, vi } from 'vitest'
import { canOfferDefault, isSameProgram, LINUX_DOCUMENT_TYPES, makeDefaultBrowser, readDefaultBrowser, SETTLE_MS, unavailableReason } from '../default-browser.js'
import type { DefaultBrowserHost, Launcher } from '../default-browser.js'

const PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'win32', 'darwin']

describe('what each platform and launcher may do', () => {
  it('is unavailable from source, whatever the platform', () => {
    for (const platform of [...PLATFORMS, 'freebsd' as const]) expect(unavailableReason({ platform, launcher: 'source' })).toBe('source')
  })

  it('is unavailable from an AppImage, which moves, so a registration naming it goes stale', () => {
    for (const platform of PLATFORMS) expect(unavailableReason({ platform, launcher: 'appimage' })).toBe('appimage')
  })

  it('is available to an installed package on Linux, Windows and macOS', () => {
    for (const platform of PLATFORMS) expect(unavailableReason({ platform, launcher: 'installed' })).toBeUndefined()
  })

  it('is unavailable to an installed package on a platform with no way to register', () => {
    expect(unavailableReason({ platform: 'freebsd', launcher: 'installed' })).toBe('platform')
    expect(unavailableReason({ platform: 'sunos', launcher: 'installed' })).toBe('platform')
  })

  it('offers to become the default only where it can', () => {
    expect(canOfferDefault({ platform: 'linux', launcher: 'installed' })).toBe(true)
    expect(canOfferDefault({ platform: 'linux', launcher: 'source' })).toBe(false)
    expect(canOfferDefault({ platform: 'linux', launcher: 'appimage' })).toBe(false)
  })
})

function host (over: { platform?: NodeJS.Platform, launcher?: Launcher, registered?: { value: boolean } } = {}): DefaultBrowserHost & { isDefault: ReturnType<typeof vi.fn>, setDefault: ReturnType<typeof vi.fn>, openSettings: ReturnType<typeof vi.fn>, setDocumentDefault: ReturnType<typeof vi.fn> } {
  const registered = over.registered ?? { value: false }
  return {
    platform: over.platform ?? 'linux',
    launcher: over.launcher ?? 'installed',
    isDefault: vi.fn(async () => registered.value),
    setDefault: vi.fn(() => { registered.value = true; return true }),
    openSettings: vi.fn(async () => {}),
    setDocumentDefault: vi.fn(() => true)
  }
}

describe('readDefaultBrowser', () => {
  it('asks the system nothing where the answer could not be acted on, and says why', async () => {
    for (const launcher of ['source', 'appimage'] as const) {
      const h = host({ launcher })
      expect(await readDefaultBrowser(h)).toEqual({ state: 'unavailable', reason: launcher })
      expect(h.isDefault).not.toHaveBeenCalled()
    }
    const bsd = host({ platform: 'freebsd' })
    expect(await readDefaultBrowser(bsd)).toEqual({ state: 'unavailable', reason: 'platform' })
    expect(bsd.isDefault).not.toHaveBeenCalled()
  })

  it('reads both protocols when installed, and is default only when both are Orivon\'s', async () => {
    const h = host({ registered: { value: true } })
    expect(await readDefaultBrowser(h)).toEqual({ state: 'default' })
    expect(h.isDefault).toHaveBeenCalledWith('http')
    expect(h.isDefault).toHaveBeenCalledWith('https')
    const half = host()
    half.isDefault.mockImplementation(async (protocol: string) => protocol === 'http')
    expect(await readDefaultBrowser(half)).toEqual({ state: 'can-set' })
  })
})

describe('makeDefaultBrowser', () => {
  it('never registers from source or from an AppImage', async () => {
    for (const launcher of ['source', 'appimage'] as const) {
      const h = host({ launcher })
      expect(await makeDefaultBrowser(h, async () => {})).toEqual({ state: 'unavailable', reason: launcher, ok: false, handedOff: false })
      expect(h.setDefault).not.toHaveBeenCalled()
      expect(h.openSettings).not.toHaveBeenCalled()
    }
  })

  it('registers http and https, waits, and reads the answer back', async () => {
    const h = host()
    const wait = vi.fn(async () => {})
    expect(await makeDefaultBrowser(h, wait)).toEqual({ state: 'default', ok: true, handedOff: false })
    expect(h.setDefault.mock.calls).toEqual([['http'], ['https']])
    expect(wait).toHaveBeenCalledWith(SETTLE_MS)
  })

  it('says so when the system did not take the change', async () => {
    const h = host()
    h.setDefault.mockImplementation(() => false)
    h.isDefault.mockImplementation(async () => false)
    expect(await makeDefaultBrowser(h, async () => {})).toEqual({ state: 'can-set', ok: false, handedOff: false })
  })

  it('survives a registration that throws, and still reads the state back', async () => {
    const h = host()
    h.setDefault.mockImplementation(() => { throw new Error('no xdg-settings') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await makeDefaultBrowser(h, async () => {})).toEqual({ state: 'can-set', ok: false, handedOff: false })
    log.mockRestore()
  })

  it('does nothing when Orivon already is the default', async () => {
    const h = host({ registered: { value: true } })
    expect(await makeDefaultBrowser(h, async () => {})).toEqual({ state: 'default', ok: true, handedOff: false })
    expect(h.setDefault).not.toHaveBeenCalled()
  })

  it('hands the choice to the system on Windows, which does not let a program take it, and registers nothing', async () => {
    const h = host({ platform: 'win32' })
    expect(await makeDefaultBrowser(h, async () => {})).toEqual({ state: 'can-set', ok: false, handedOff: true })
    expect(h.openSettings).toHaveBeenCalledTimes(1)
    expect(h.setDefault).not.toHaveBeenCalled()
  })

  it('registers on macOS, where the system asks the person to confirm, and says the choice is theirs while it is not yet the default', async () => {
    const asked = host({ platform: 'darwin' })
    asked.setDefault.mockImplementation(() => true)
    asked.isDefault.mockImplementation(async () => false)
    expect(await makeDefaultBrowser(asked, async () => {})).toEqual({ state: 'can-set', ok: false, handedOff: true })
    expect(asked.setDefault.mock.calls).toEqual([['http'], ['https']])
    expect(asked.openSettings).not.toHaveBeenCalled()

    const accepted = host({ platform: 'darwin' })
    expect(await makeDefaultBrowser(accepted, async () => {})).toEqual({ state: 'default', ok: true, handedOff: false })
  })

  it('does not hand over on Windows when Orivon already is the default, and reports a settings page that would not open as no hand-over', async () => {
    const already = host({ platform: 'win32', registered: { value: true } })
    expect(await makeDefaultBrowser(already, async () => {})).toEqual({ state: 'default', ok: true, handedOff: false })
    expect(already.openSettings).not.toHaveBeenCalled()

    const failing = host({ platform: 'win32' })
    failing.openSettings.mockRejectedValue(new Error('no handler'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await makeDefaultBrowser(failing, async () => {})).toEqual({ state: 'can-set', ok: false, handedOff: false })
    log.mockRestore()
  })
})

describe('the document types a default browser takes', () => {
  it('are html, xhtml and pdf, and not svg, which stays under Open with', () => {
    expect(LINUX_DOCUMENT_TYPES).toEqual(['text/html', 'application/xhtml+xml', 'application/pdf'])
  })

  it('are registered on Linux with the web protocols, one type at a time', async () => {
    const h = host()
    await makeDefaultBrowser(h, async () => {})
    expect(h.setDocumentDefault.mock.calls.map(([type]) => type)).toEqual([...LINUX_DOCUMENT_TYPES])
  })

  it('survive one type that cannot be registered', async () => {
    const h = host()
    h.setDocumentDefault.mockImplementationOnce(() => { throw new Error('xdg-mime failed') })
    await makeDefaultBrowser(h, async () => {})
    expect(h.setDocumentDefault).toHaveBeenCalledTimes(LINUX_DOCUMENT_TYPES.length)
  })

  it('are left to the person on macOS and Windows, and never touched from source or an AppImage', async () => {
    for (const over of [{ platform: 'darwin' as const }, { platform: 'win32' as const }, { launcher: 'source' as const }, { launcher: 'appimage' as const }]) {
      const h = host(over)
      await makeDefaultBrowser(h, async () => {})
      expect(h.setDocumentDefault).not.toHaveBeenCalled()
    }
  })
})

describe('isSameProgram', () => {
  it('compares the handler Windows reports with this program, ignoring case, quotes and slash direction', () => {
    expect(isSameProgram('C:\\Program Files\\Orivon\\Orivon.exe', 'C:\\Program Files\\Orivon\\Orivon.exe')).toBe(true)
    expect(isSameProgram('c:\\program files\\orivon\\orivon.exe', 'C:\\Program Files\\Orivon\\Orivon.exe')).toBe(true)
    expect(isSameProgram('"C:\\Program Files\\Orivon\\Orivon.exe"', 'C:\\Program Files\\Orivon\\Orivon.exe')).toBe(true)
    expect(isSameProgram('C:/Program Files/Orivon/Orivon.exe', 'C:\\Program Files\\Orivon\\Orivon.exe')).toBe(true)
  })

  it('is false for another program, an empty path or a path that only starts the same', () => {
    expect(isSameProgram('C:\\Program Files\\Other\\Other.exe', 'C:\\Program Files\\Orivon\\Orivon.exe')).toBe(false)
    expect(isSameProgram('', 'C:\\Program Files\\Orivon\\Orivon.exe')).toBe(false)
    expect(isSameProgram('C:\\Program Files\\Orivon\\Orivon.exe.bak', 'C:\\Program Files\\Orivon\\Orivon.exe')).toBe(false)
    expect(isSameProgram('', '')).toBe(false)
  })
})
