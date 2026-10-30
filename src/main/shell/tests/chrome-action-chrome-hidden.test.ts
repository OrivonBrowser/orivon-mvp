import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromeHidden } from '../actions/chrome-hidden.js'
import { CHROME_ACTIONS, runChromeAction } from '../chrome-actions.js'
import type { ChromeActionContext } from '../chrome-actions.js'

function context (state: { visible?: boolean, minimized?: boolean, destroyed?: boolean, chromeShown?: boolean } = {}): { ctx: ChromeActionContext, reshow: ReturnType<typeof vi.fn> } {
  const reshow = vi.fn()
  const window = {
    window: { isDestroyed: () => state.destroyed === true, isVisible: () => state.visible !== false, isMinimized: () => state.minimized === true },
    chrome: { getVisible: () => state.chromeShown !== false },
    overlays: { reshow }
  }
  return { ctx: { window, services: {}, copyAddress: async () => {} } as unknown as ChromeActionContext, reshow }
}

afterEach(() => { vi.useRealTimers() })

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
})
