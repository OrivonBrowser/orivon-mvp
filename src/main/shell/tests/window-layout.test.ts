import { describe, expect, it, vi } from 'vitest'
import { BOOKMARKS_BAR_HEIGHT, CHROME_HEIGHT, CHROME_TOP_ROWS, chromeRect, createWindowLayout } from '../window-layout.js'

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

describe('createWindowLayout: page insets', () => {
  function insetSetup (insets: { left: number, right: number }, fullscreen: string | null = null): ReturnType<typeof createWindowLayout> {
    const win = { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }) }
    const chrome = { setVisible: vi.fn(), setBounds: vi.fn() }
    return createWindowLayout({ win: win as never, chrome: chrome as never, fullscreenTabId: () => fullscreen, bookmarksBarShown: () => false, pageInsets: () => insets })
  }

  it('narrows the page area by what a panel takes on the right, leaving its x alone', () => {
    expect(insetSetup({ left: 0, right: 360 }).tabBounds()).toEqual({ x: 0, y: CHROME_TOP_ROWS, width: 640, height: 700 - CHROME_TOP_ROWS })
  })

  it('moves the page area right by what a panel takes on the left', () => {
    expect(insetSetup({ left: 300, right: 0 }).tabBounds()).toEqual({ x: 300, y: CHROME_TOP_ROWS, width: 700, height: 700 - CHROME_TOP_ROWS })
  })

  it('gives a page in HTML fullscreen the whole window whatever the panel says', () => {
    expect(insetSetup({ left: 0, right: 360 }, 'tab-1').tabBounds()).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })

  it('never goes negative in a window narrower than its insets', () => {
    expect(insetSetup({ left: 700, right: 700 }).tabBounds().width).toBe(0)
  })
})

describe('createWindowLayout: reaching the chrome', () => {
  it('lays the chrome over more than the window height, from the same corner and at the same width, while a tab is pressed, and back after', () => {
    const { layout, chrome } = setup()

    layout.reachChrome(true)
    const reaching = chrome.setBounds.mock.calls.at(-1)?.[0] as { x: number, y: number, width: number, height: number }
    expect(reaching).toMatchObject({ x: 0, y: 0 })
    expect(reaching.width).toBe(1000)
    expect(reaching.height).toBeGreaterThan(700)

    layout.layoutChrome()
    expect(chrome.setBounds.mock.calls.at(-1)?.[0]).toEqual(reaching)

    layout.reachChrome(false)
    expect(chrome.setBounds.mock.calls.at(-1)?.[0]).toEqual({ x: 0, y: 0, width: 1000, height: CHROME_TOP_ROWS })
  })

  it('does nothing twice, and gives the chrome its size back by itself when no one lets go', () => {
    vi.useFakeTimers()
    try {
      const { layout, chrome } = setup()
      layout.reachChrome(true)
      layout.reachChrome(true)
      expect(chrome.setBounds).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(60_000)
      expect(chrome.setBounds).toHaveBeenCalledTimes(2)
      expect(chrome.setBounds.mock.calls.at(-1)?.[0]).toEqual({ x: 0, y: 0, width: 1000, height: CHROME_TOP_ROWS })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never moves the chrome\'s corner or width, which would lay its page out again', () => {
    expect(chromeRect({ width: 800, height: 600 }, CHROME_TOP_ROWS, true)).toMatchObject({ x: 0, y: 0, width: 800 })
  })
})
