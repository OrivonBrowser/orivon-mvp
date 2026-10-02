// A click on the button that opened an overlay is judged against the press it completes: the press took the focus the
// overlay held and closed it, and the click that follows, however late, is that same gesture and must not reopen it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayViewSpec } from '../overlay-view.js'
import { CLOSE_LIKE_POPUP } from '../overlay-types.js'
import type { OverlayDef } from '../overlay-types.js'

const { views } = vi.hoisted(() => ({ views: [] as Array<{ onBlur: () => void }> }))

vi.mock('../overlay-view.js', () => ({
  focusedContents: () => undefined,
  createOverlayView: (spec: OverlayViewSpec) => {
    views.push({ onBlur: spec.onBlur })
    return {
      id: 100 + views.length,
      attach: () => {},
      detach: () => {},
      setBounds: () => {},
      focusWhenReady: () => {},
      send: () => {},
      refreshBackground: () => {},
      isDestroyed: () => false,
      destroy: () => {}
    }
  }
}))
vi.mock('../../shell/theme-colors.js', () => ({ onThemeUpdated: () => () => {} }))

const { createOverlayHost } = await import('../overlay-host.js')

const ANCHOR = { x: 900, y: 40, width: 30, height: 30 }
const DEF = {
  name: 'a', placement: { kind: 'anchor', width: 380, align: 'right' }, surface: 'panel', focus: 'take', layer: 'popup',
  closeOn: CLOSE_LIKE_POPUP, keep: 'warm', attach: () => ({ request: () => undefined })
} as OverlayDef

function setup (): ReturnType<typeof createOverlayHost> {
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => true }
  return createOverlayHost({
    win: win as never,
    contentView: {} as never,
    dirname: '/app',
    defs: [DEF],
    context: () => ({ window: { chrome: { webContents: { id: 5 } } }, services: { windows: { all: () => [{ window: win }] } } }) as never,
    area: () => ({ x: 0, y: 76, width: 1200, height: 724 }),
    activeContents: () => undefined
  })
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => { vi.useRealTimers(); views.length = 0 })

describe('createOverlayHost: a toggle that names its press', () => {
  it('a click held down for longer than the debounce is still the echo of the press that closed the overlay', () => {
    const host = setup()
    host.show('a', ANCHOR)
    const pressedAt = Date.now()
    views[0]?.onBlur()
    vi.advanceTimersByTime(1_000)
    host.toggle('a', ANCHOR, undefined, pressedAt)
    expect(host.isOpen('a')).toBe(false)
  })

  it('a fresh press just after another close opens the overlay: the debounce is for the press that closed it, not for the clock', () => {
    const host = setup()
    host.show('a', ANCHOR)
    views[0]?.onBlur()
    vi.advanceTimersByTime(120)
    host.toggle('a', ANCHOR, undefined, Date.now() - 40)
    expect(host.isOpen('a')).toBe(true)
  })

  it('a press time that is not a time, or lies in the future, falls back to the debounce', () => {
    const host = setup()
    host.show('a', ANCHOR)
    views[0]?.onBlur()
    vi.advanceTimersByTime(100)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Date.now() + 60_000]) {
      host.toggle('a', ANCHOR, undefined, bad)
      expect(host.isOpen('a')).toBe(false)
    }
    vi.advanceTimersByTime(300)
    host.toggle('a', ANCHOR, undefined, Date.now() - 20)
    expect(host.isOpen('a')).toBe(true)
  })
})
