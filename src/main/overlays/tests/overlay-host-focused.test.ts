// A `never` overlay's handler hears when its view takes the keyboard, inside the focus event and before the host hands
// the keyboard back to the page it came from.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayViewSpec } from '../overlay-view.js'
import { CLOSE_LIKE_BAR } from '../overlay-types.js'
import type { OverlayDef, OverlayHandler } from '../overlay-types.js'

const { views, focus } = vi.hoisted(() => ({ views: [] as OverlayViewSpec[], focus: { current: undefined as unknown } }))

vi.mock('../overlay-view.js', () => ({
  focusedContents: () => focus.current,
  createOverlayView: (spec: OverlayViewSpec) => {
    views.push(spec)
    return {
      id: 100 + views.length,
      attach: () => {}, detach: () => {}, hide: () => {}, setBounds: () => {}, focusWhenReady: () => {}, send: () => {},
      refreshBackground: () => {}, isDestroyed: () => false, destroy: () => {}
    }
  }
}))
vi.mock('../../shell/theme-colors.js', () => ({ onThemeUpdated: () => () => {} }))

const { createOverlayHost } = await import('../overlay-host.js')

const ANCHOR = { x: 900, y: 40, width: 30, height: 30 }

function def (handler: Partial<OverlayHandler>): OverlayDef {
  return {
    name: 'bar', placement: { kind: 'anchor', width: 380, align: 'right' }, surface: 'panel', focus: 'never', layer: 'bar',
    closeOn: CLOSE_LIKE_BAR, keep: 'fresh', attach: () => ({ request: () => undefined, ...handler })
  } as OverlayDef
}

function setup (defs: OverlayDef[], page: { id: number, focus: () => void }): ReturnType<typeof createOverlayHost> {
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => true }
  return createOverlayHost({
    win: win as never,
    contentView: {} as never,
    dirname: '/app',
    defs,
    context: () => ({ window: { chrome: { webContents: { id: 5 } } }, services: { windows: { all: () => [{ window: win }] } } }) as never,
    area: () => ({ x: 0, y: 76, width: 1200, height: 724 }),
    activeContents: () => ({ ...page, isDestroyed: () => false }) as never
  })
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => { vi.useRealTimers(); views.length = 0; focus.current = undefined })

describe('createOverlayHost: the view of a never overlay takes the keyboard', () => {
  it('tells the handler before the keyboard is handed back', () => {
    const order: string[] = []
    const page = { id: 1, focus: () => { order.push('handed back') } }
    const host = setup([def({ focused: () => { order.push('focused') } })], page)
    host.show('bar', ANCHOR)
    views[0]?.onTake()
    views[0]?.onFocus()
    expect(order).toEqual(['focused', 'handed back'])
  })

  it('does not tell the handler once the overlay is closed, and survives a handler that throws', () => {
    const focused = vi.fn(() => { throw new Error('boom') })
    const host = setup([def({ focused })], { id: 1, focus: vi.fn() })
    host.show('bar', ANCHOR)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    views[0]?.onTake()
    expect(focused).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
    host.close('bar')
    views[0]?.onTake()
    expect(focused).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})
