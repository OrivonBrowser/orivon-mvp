import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromeHidden } from '../actions/chrome-hidden.js'
import { CHROME_ACTIONS, runChromeAction } from '../chrome-actions.js'
import type { ChromeActionContext } from '../chrome-actions.js'

interface State { visible?: boolean, minimized?: boolean, destroyed?: boolean, chromeShown?: boolean, shown?: string[], readsHidden?: boolean }

function context (state: State = {}): { ctx: ChromeActionContext, reshow: ReturnType<typeof vi.fn>, read: ReturnType<typeof vi.fn> } {
  const reshow = vi.fn(() => state.shown ?? ['loading-screen'])
  const read = vi.fn(async () => state.readsHidden === true ? 'hidden' : 'visible')
  const window = {
    window: { isDestroyed: () => state.destroyed === true, isVisible: () => state.visible !== false, isMinimized: () => state.minimized === true },
    chrome: { getVisible: () => state.chromeShown !== false, webContents: { executeJavaScript: read } },
    overlays: { reshow }
  }
  return { ctx: { window, services: {}, copyAddress: async () => {} } as unknown as ChromeActionContext, reshow, read }
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

  it('writes one line, not one per report, when the three repairs did not bring the chrome back', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = context()
    for (let i = 0; i < 8; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[shell] the chrome page read hidden again after 3 repairs in 2000 ms; one more repair is set for the end of that span')
    vi.advanceTimersByTime(1_000)
    for (let i = 0; i < 8; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('repairs once more at the end of the span when the chrome page still reads hidden then', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, reshow, read } = context({ readsHidden: true })
    for (let i = 0; i < 4; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    expect(reshow).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1_900)
    expect(read).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(read).toHaveBeenCalledWith('document.visibilityState')
    expect(reshow).toHaveBeenCalledTimes(4)
  })

  it('leaves a chrome that shows itself again by the end of the span alone', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, reshow } = context({ readsHidden: false })
    for (let i = 0; i < 4; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(reshow).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('writes a line when the chrome page still reads hidden after the repair at the end of the span', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = context({ readsHidden: true })
    for (let i = 0; i < 4; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    await vi.advanceTimersByTimeAsync(2_100 + 400)
    expect(warn).toHaveBeenLastCalledWith('[shell] the chrome page still reads hidden after the repair at the end of the span; left as it is')
  })

  it.each([[{ destroyed: true }], [{ visible: false }], [{ minimized: true }]] as Array<[State]>)('does not repair at the end of the span in a window that changed meanwhile: %j', async (change) => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state: State = { readsHidden: true }
    const { ctx, reshow, read } = context(state)
    for (let i = 0; i < 4; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    Object.assign(state, change)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(reshow).toHaveBeenCalledTimes(3)
    expect(read).not.toHaveBeenCalled()
  })

  it('logs a later spent budget as well, though it comes less than two seconds after the first, and sets one repair for each', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = context({ readsHidden: false })
    for (let i = 0; i < 3; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    await vi.advanceTimersByTimeAsync(500)
    runChromeAction('chrome.hidden', undefined, ctx)
    expect(warn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_600)
    for (let i = 0; i < 4; i += 1) runChromeAction('chrome.hidden', undefined, ctx)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
