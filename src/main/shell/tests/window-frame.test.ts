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

function fakeWindow (): { win: never, order: string[] } {
  const order: string[] = []
  const win = {
    isDestroyed: () => false,
    show: () => { order.push('show') },
    showInactive: () => { order.push('showInactive') },
    setBounds: () => { order.push('setBounds') },
    maximize: () => { order.push('maximize') }
  }
  return { win: win as never, order }
}

const bounds = { x: 1, y: 2, width: 900, height: 600 }

describe('createWindowFrame', () => {
  it('opens a kiosk window as one, and an ordinary one not', () => {
    expect(createWindowFrame('/out/main', {}, false, true)).toMatchObject({ kiosk: true })
    expect(created.at(-1)).toMatchObject({ kiosk: true })
    expect(createWindowFrame('/out/main')).toMatchObject({ kiosk: false })
    expect(created.at(-1)).toMatchObject({ kiosk: false })
  })

  it('centres at the default size, over which a saved place wins', () => {
    expect(createWindowFrame('/out/main').initialBounds).toEqual({ x: 320, y: 140, width: 1280, height: 800 })
    expect(createWindowFrame('/out/main', { x: 5, y: 6, width: 700, height: 500 }).initialBounds).toEqual({ x: 5, y: 6, width: 700, height: 500 })
  })
})

describe('showWhenReady', () => {
  it('maximises after asserting the size, so un-maximising returns to it', () => {
    const { win, order } = fakeWindow()
    showWhenReady({ win, initialBounds: bounds, kiosk: false }, { instant: true, maximized: true })
    expect(order).toEqual(['show', 'setBounds', 'maximize'])
  })

  it('does not maximise an ordinary window', () => {
    const { win, order } = fakeWindow()
    showWhenReady({ win, initialBounds: bounds, kiosk: false }, { instant: true })
    expect(order).toEqual(['show', 'setBounds'])
  })

  it('leaves a kiosk window at the whole screen: no size is asserted on it', () => {
    const { win, order } = fakeWindow()
    showWhenReady({ win, initialBounds: bounds, kiosk: true }, { instant: true, maximized: true })
    expect(order).toEqual(['show'])
  })
})
