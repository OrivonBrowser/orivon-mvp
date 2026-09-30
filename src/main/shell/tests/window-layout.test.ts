import { describe, expect, it, vi } from 'vitest'
import { BOOKMARKS_BAR_HEIGHT, CHROME_HEIGHT, CHROME_TOP_ROWS, createWindowLayout } from '../window-layout.js'

function setup (options: { fullscreen?: string | null, bar?: boolean, destroyed?: boolean, kiosk?: boolean } = {}): { layout: ReturnType<typeof createWindowLayout>, chrome: { setVisible: ReturnType<typeof vi.fn>, setBounds: ReturnType<typeof vi.fn> }, state: { fullscreen: string | null, bar: boolean, destroyed: boolean } } {
  const state = { fullscreen: options.fullscreen ?? null, bar: options.bar ?? false, destroyed: options.destroyed ?? false }
  const win = { isDestroyed: () => state.destroyed, getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }) }
  const chrome = { setVisible: vi.fn(), setBounds: vi.fn() }
  const layout = createWindowLayout({ win: win as never, chrome: chrome as never, fullscreenTabId: () => state.fullscreen, bookmarksBarShown: () => state.bar, kiosk: options.kiosk === true })
  return { layout, chrome, state }
}

describe('createWindowLayout', () => {
  it('is the two toolbar rows, plus the bookmarks bar only while it shows', () => {
    const { layout, state } = setup()

    expect(layout.chromeHeight()).toBe(CHROME_TOP_ROWS)
    state.bar = true
    expect(layout.chromeHeight()).toBe(CHROME_HEIGHT)
    expect(CHROME_HEIGHT - CHROME_TOP_ROWS).toBe(BOOKMARKS_BAR_HEIGHT)
  })

  it('puts the chrome across the top at its own height and shows it', () => {
    const { layout, chrome } = setup({ bar: true })

    layout.layoutChrome()

    expect(chrome.setVisible).toHaveBeenCalledWith(true)
    expect(chrome.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1000, height: CHROME_HEIGHT })
  })

  it('gives the pages the room under the chrome', () => {
    const { layout } = setup()

    expect(layout.tabBounds()).toEqual({ x: 0, y: CHROME_TOP_ROWS, width: 1000, height: 700 - CHROME_TOP_ROWS })
  })

  it('hides the chrome and gives a fullscreen page the whole window', () => {
    const { layout, chrome } = setup({ fullscreen: 'tab-1' })

    layout.layoutChrome()

    expect(chrome.setVisible).toHaveBeenCalledWith(false)
    expect(layout.tabBounds()).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })

  it('has no chrome in a kiosk: the page takes the whole window and the chrome stays hidden', () => {
    const { layout, chrome } = setup({ kiosk: true, bar: true })

    layout.layoutChrome()

    expect(layout.chromeHeight()).toBe(0)
    expect(chrome.setVisible).toHaveBeenCalledWith(false)
    expect(layout.tabBounds()).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })

  it('touches nothing and reports an empty area once the window is destroyed', () => {
    const { layout, chrome } = setup({ destroyed: true })

    layout.layoutChrome()

    expect(chrome.setBounds).not.toHaveBeenCalled()
    expect(layout.tabBounds()).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})
