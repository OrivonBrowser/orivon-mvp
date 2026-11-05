import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromeHidden } from '../actions/chrome-hidden.js'
import { CHROME_ACTIONS, runChromeAction } from '../chrome-actions.js'
import type { ChromeActionContext } from '../chrome-actions.js'

function context (state: { visible?: boolean, minimized?: boolean, destroyed?: boolean, chromeShown?: boolean, shown?: string[] } = {}): { ctx: ChromeActionContext, reshow: ReturnType<typeof vi.fn> } {
  const reshow = vi.fn(() => state.shown ?? ['loading-screen'])
  const window = {
    window: { isDestroyed: () => state.destroyed === true, isVisible: () => state.visible !== false, isMinimized: () => state.minimized === true },
    chrome: { getVisible: () => state.chromeShown !== false },
    overlays: { reshow }
  }
  return { ctx: { window, services: {}, copyAddress: async () => {} } as unknown as ChromeActionContext, reshow }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('the chrome.hidden chrome action', () => {
  it('is registered', () => {
    expect(CHROME_ACTIONS['chrome.hidden']).toBe(chromeHidden)
  })

  it('shows the overlays again when the chrome reads hidden in a window on screen', () => {
    const { ctx, reshow } = context()
    runChromeAction('chrome.hidden', undefined, ctx)
    expect(reshow).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a window that is minimized, hidden or gone, or a chrome that is meant to be hidden', () => {
    for (const state of [{ minimized: true }, { visible: false }, { destroyed: true }, { chromeShown: false }]) {
      const { ctx, reshow } = context(state)
      runChromeAction('chrome.hidden', undefined, ctx)
      expect(reshow).not.toHaveBeenCalled()
    }
  })

  it('stops after three repairs inside two seconds, and works again later', () => {
    vi.useFakeTimers()
    const { ctx, reshow } = context()
    for (let i = 0; i < 6; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    expect(reshow).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(2_100)
    runChromeAction('chrome.hidden', undefined, ctx)
    expect(reshow).toHaveBeenCalledTimes(4)
  })

  it('writes a line to the log for each repair, naming the overlays it showed again', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { ctx } = context({ shown: ['question', 'loading-screen'] })
    runChromeAction('chrome.hidden', undefined, ctx)
    runChromeAction('chrome.hidden', undefined, ctx)
    expect(info).toHaveBeenCalledTimes(2)
    expect(info).toHaveBeenNthCalledWith(1, '[shell] the chrome page read hidden; showed question, loading-screen again (repair 1 of 3)')
    expect(info).toHaveBeenNthCalledWith(2, '[shell] the chrome page read hidden; showed question, loading-screen again (repair 2 of 3)')
  })

  it('says so when no overlay was up to show again', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { ctx } = context({ shown: [] })
    runChromeAction('chrome.hidden', undefined, ctx)
    expect(info).toHaveBeenCalledWith('[shell] the chrome page read hidden; showed no overlay again (repair 1 of 3)')
  })

  it('writes one line, not one per report, when it leaves a chrome that stays hidden alone', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = context()
    for (let i = 0; i < 8; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[shell] the chrome page still reads hidden after 3 repairs in 2000 ms; left as it is')
    vi.advanceTimersByTime(1_000)
    for (let i = 0; i < 8; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
