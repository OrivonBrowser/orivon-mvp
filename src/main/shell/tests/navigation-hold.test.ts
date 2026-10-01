import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { holdNavigation, isNavigationHeld, refuseHeldNavigation } from '../navigation-hold.js'

type Attempt = { url: string, isMainFrame: boolean, preventDefault: () => void }

function tab (): { wc: EventEmitter, attempt: (event: string, url: string, isMainFrame?: boolean) => boolean } {
  const wc = new EventEmitter()
  refuseHeldNavigation(wc as never)
  return {
    wc,
    attempt: (event, url, isMainFrame = true) => {
      let prevented = false
      const detail: Attempt = { url, isMainFrame, preventDefault: () => { prevented = true } }
      wc.emit(event, detail)
      return prevented
    }
  }
}

describe('holdNavigation', () => {
  it('holds until released, and releasing twice does not release another hold', () => {
    const wc = {}
    const first = holdNavigation(wc)
    const second = holdNavigation(wc)
    first()
    first()
    expect(isNavigationHeld(wc)).toBe(true)
    second()
    expect(isNavigationHeld(wc)).toBe(false)
  })

  it('holds one contents only, and nothing for no contents', () => {
    const a = {}
    const release = holdNavigation(a)
    expect(isNavigationHeld({})).toBe(false)
    expect(() => { holdNavigation(undefined)() }).not.toThrow()
    release()
  })
})

describe('refuseHeldNavigation', () => {
  it('drops a page-started navigation, a redirect and a frame navigation of the main frame while held', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { wc, attempt } = tab()
    const release = holdNavigation(wc)

    expect(attempt('will-navigate', 'https://elsewhere.example/')).toBe(true)
    expect(attempt('will-frame-navigate', 'https://elsewhere.example/')).toBe(true)
    expect(attempt('will-redirect', 'https://elsewhere.example/')).toBe(true)
    expect(log).toHaveBeenCalledTimes(3)

    release()
    log.mockRestore()
  })

  it('lets a subframe navigate: only the page the question is about is held', () => {
    const { wc, attempt } = tab()
    const release = holdNavigation(wc)

    expect(attempt('will-frame-navigate', 'https://ad.example/', false)).toBe(false)
    expect(attempt('will-redirect', 'https://ad.example/', false)).toBe(false)

    release()
  })

  it('lets everything through once released, and for a tab that was never held', () => {
    const { wc, attempt } = tab()
    expect(attempt('will-navigate', 'https://a.example/')).toBe(false)
    holdNavigation(wc)()
    expect(attempt('will-frame-navigate', 'https://a.example/')).toBe(false)
  })
})
