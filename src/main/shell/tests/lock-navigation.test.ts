import { afterEach, describe, expect, it, vi } from 'vitest'
import { lockNavigation } from '../lock-navigation.js'

interface FakeWebContents {
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  listeners: Record<string, Array<(...args: unknown[]) => void>>
}

function fakeWebContents (): FakeWebContents {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  return {
    setWindowOpenHandler: vi.fn(),
    listeners,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners[event] = [...(listeners[event] ?? []), listener]
    })
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('lockNavigation', () => {
  it('denies every popup unconditionally', () => {
    const wc = fakeWebContents()
    lockNavigation(wc as unknown as Parameters<typeof lockNavigation>[0])

    expect(wc.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    const handler = wc.setWindowOpenHandler.mock.calls[0]?.[0] as () => { action: string }
    expect(handler()).toEqual({ action: 'deny' })
  })

  describe('with no allowedUrl (an isolated context)', () => {
    it('prevents will-navigate, will-redirect and a main-frame will-frame-navigate', () => {
      const wc = fakeWebContents()
      lockNavigation(wc as unknown as Parameters<typeof lockNavigation>[0])

      const navigateEvent = { preventDefault: vi.fn(), url: 'https://attacker.example' }
      wc.listeners['will-navigate']?.[0]?.(navigateEvent)
      expect(navigateEvent.preventDefault).toHaveBeenCalledTimes(1)

      const redirectEvent = { preventDefault: vi.fn(), url: 'https://attacker.example' }
      wc.listeners['will-redirect']?.[0]?.(redirectEvent)
      expect(redirectEvent.preventDefault).toHaveBeenCalledTimes(1)

      const mainFrameEvent = { preventDefault: vi.fn(), url: 'https://attacker.example', isMainFrame: true }
      wc.listeners['will-frame-navigate']?.[0]?.(mainFrameEvent)
      expect(mainFrameEvent.preventDefault).toHaveBeenCalledTimes(1)
    })

    // The regression this file exists to pin: an event whose `url` is
    // `undefined` (every existing web-context-host.test.ts fixture builds
    // events with no `url` field at all) must still be refused when no
    // `allowedUrl` was given -- `undefined === undefined` must not read as
    // "matches the allowed URL".
    it('prevents a navigation event carrying no url at all', () => {
      const wc = fakeWebContents()
      lockNavigation(wc as unknown as Parameters<typeof lockNavigation>[0])

      const navigateEvent = { preventDefault: vi.fn() }
      wc.listeners['will-navigate']?.[0]?.(navigateEvent)
      expect(navigateEvent.preventDefault).toHaveBeenCalledTimes(1)
    })

    it('ignores a will-frame-navigate for a subframe', () => {
      const wc = fakeWebContents()
      lockNavigation(wc as unknown as Parameters<typeof lockNavigation>[0])

      const subFrameEvent = { preventDefault: vi.fn(), url: 'https://attacker.example', isMainFrame: false }
      wc.listeners['will-frame-navigate']?.[0]?.(subFrameEvent)
      expect(subFrameEvent.preventDefault).not.toHaveBeenCalled()
    })
  })

  describe('with an allowedUrl (the chrome view or a popup)', () => {
    const ALLOWED = 'https://chrome.orivon.example/index.html'

    it('lets a navigation to exactly allowedUrl through: the page loading its own document again', () => {
      const wc = fakeWebContents()
      lockNavigation(wc as unknown as Parameters<typeof lockNavigation>[0], ALLOWED)

      const navigateEvent = { preventDefault: vi.fn(), url: ALLOWED }
      wc.listeners['will-navigate']?.[0]?.(navigateEvent)
      expect(navigateEvent.preventDefault).not.toHaveBeenCalled()

      const redirectEvent = { preventDefault: vi.fn(), url: ALLOWED }
      wc.listeners['will-redirect']?.[0]?.(redirectEvent)
      expect(redirectEvent.preventDefault).not.toHaveBeenCalled()

      const frameEvent = { preventDefault: vi.fn(), url: ALLOWED, isMainFrame: true }
      wc.listeners['will-frame-navigate']?.[0]?.(frameEvent)
      expect(frameEvent.preventDefault).not.toHaveBeenCalled()
    })

    it('still prevents a navigation to anything else, including a same-origin different path', () => {
      const wc = fakeWebContents()
      lockNavigation(wc as unknown as Parameters<typeof lockNavigation>[0], ALLOWED)

      const navigateEvent = { preventDefault: vi.fn(), url: 'https://chrome.orivon.example/other.html' }
      wc.listeners['will-navigate']?.[0]?.(navigateEvent)
      expect(navigateEvent.preventDefault).toHaveBeenCalledTimes(1)

      const redirectEvent = { preventDefault: vi.fn(), url: 'https://attacker.example' }
      wc.listeners['will-redirect']?.[0]?.(redirectEvent)
      expect(redirectEvent.preventDefault).toHaveBeenCalledTimes(1)
    })

    it('logs each refusal, and nothing for the allowed URL', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const wc = fakeWebContents()
      lockNavigation(wc as unknown as Parameters<typeof lockNavigation>[0], ALLOWED)

      wc.listeners['will-navigate']?.[0]?.({ preventDefault: vi.fn(), url: ALLOWED })
      expect(warn).not.toHaveBeenCalled()
      wc.listeners['will-redirect']?.[0]?.({ preventDefault: vi.fn(), url: 'https://attacker.example' })
      expect(warn).toHaveBeenCalledWith('[lock-navigation] refused', 'https://attacker.example')
    })
  })
})
