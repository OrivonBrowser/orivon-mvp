import { describe, expect, it, vi } from 'vitest'

const created: Array<Record<string, unknown>> = []

vi.mock('electron', () => ({
  app: { isPackaged: false },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
  screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  BaseWindow: vi.fn().mockImplementation(function (this: Record<string, unknown>, options: Record<string, unknown>) {
    created.push(options)
    Object.assign(this, { on: vi.fn(), once: vi.fn(), setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn() })
  })
}))

const { createWindowFrame, showWhenReady } = await import('../window-frame.js')

function fakeWindow (): { win: never, order: string[], ready: () => void } {
  const order: string[] = []
  const listeners: Array<() => void> = []
  const win = {
    once: (_event: 'ready-to-show', listener: () => void) => { listeners.push(listener) },
    isDestroyed: () => false,
    show: () => { order.push('show') },
    showInactive: () => { order.push('showInactive') },
    setBounds: () => { order.push('setBounds') },
    maximize: () => { order.push('maximize') }
  }
  return { win: win as never, order, ready: () => { for (const listener of listeners.splice(0)) listener() } }
}

const bounds = { x: 1, y: 2, width: 900, height: 600 }

describe('createWindowFrame', () => {
  it('opens a kiosk window as one, and an ordinary one not', () => {
    expect(createWindowFrame('/out/main', {}, false, true)).toMatchObject({ kiosk: true })
    expect(created.at(-1)).toMatchObject({ kiosk: true })
    expect(createWindowFrame('/out/main')).toMatchObject({ kiosk: false })
    expect(created.at(-1)).toMatchObject({ kiosk: false })
  })

  it('never lets a window shrink below the size the toolbar needs, ordinary or private', () => {
    for (const isPrivate of [false, true]) {
      createWindowFrame('/out/main', {}, isPrivate)
      expect(created.at(-1)).toMatchObject({ minWidth: 500, minHeight: 400 })
    }
  })

  it('centres at the default size, over which a saved place wins', () => {
    expect(createWindowFrame('/out/main').initialBounds).toEqual({ x: 320, y: 140, width: 1280, height: 800 })
    expect(createWindowFrame('/out/main', { x: 5, y: 6, width: 700, height: 500 }).initialBounds).toEqual({ x: 5, y: 6, width: 700, height: 500 })
  })
})

describe('showWhenReady', () => {
  it('maximises after asserting the size, so un-maximising returns to it', () => {
    const { win, order } = fakeWindow()
    showWhenReady({ win, initialBounds: bounds, kiosk: false }, { maximized: true })
    expect(order).toEqual(['show', 'setBounds', 'maximize'])
  })

  it('does not maximise an ordinary window', () => {
    const { win, order } = fakeWindow()
    showWhenReady({ win, initialBounds: bounds, kiosk: false }, {})
    expect(order).toEqual(['show', 'setBounds'])
  })

  it('shows an inactive window without taking focus, and says when it is shown', () => {
    const { win, order } = fakeWindow()
    const onShown = vi.fn()
    showWhenReady({ win, initialBounds: bounds, kiosk: false }, { inactive: true, onShown })
    expect(order).toEqual(['showInactive', 'setBounds'])
    expect(onShown).toHaveBeenCalledTimes(1)
  })

  it('leaves a kiosk window at the whole screen: no size is asserted on it', () => {
    const { win, order } = fakeWindow()
    showWhenReady({ win, initialBounds: bounds, kiosk: true }, { maximized: true })
    expect(order).toEqual(['show'])
  })

  it('shows a window after the launch is first at once, before any event', () => {
    const { win, order } = fakeWindow()
    const onShown = vi.fn()
    showWhenReady({ win, initialBounds: bounds, kiosk: false }, { onShown })
    expect(order).toEqual(['show', 'setBounds'])
    expect(onShown).toHaveBeenCalledTimes(1)
  })

  it('holds the launch\'s first window until it can paint, then shows it once', () => {
    vi.useFakeTimers()
    try {
      const { win, order, ready } = fakeWindow()
      const onShown = vi.fn()
      showWhenReady({ win, initialBounds: bounds, kiosk: false }, { firstOfLaunch: true, onShown })
      expect(order).toEqual([])
      ready()
      expect(order).toEqual(['show', 'setBounds'])
      vi.advanceTimersByTime(2000)
      expect(order).toEqual(['show', 'setBounds'])
      expect(onShown).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the launch\'s first window after the fallback delay when ready-to-show never comes', () => {
    vi.useFakeTimers()
    try {
      const { win, order } = fakeWindow()
      showWhenReady({ win, initialBounds: bounds, kiosk: false }, { firstOfLaunch: true })
      vi.advanceTimersByTime(999)
      expect(order).toEqual([])
      vi.advanceTimersByTime(1)
      expect(order).toEqual(['show', 'setBounds'])
    } finally {
      vi.useRealTimers()
    }
  })
})
