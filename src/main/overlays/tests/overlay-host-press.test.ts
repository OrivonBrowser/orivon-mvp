// A click on the button that opened an overlay is judged against the press it completes: the press took the focus the
// overlay held and closed it, and the click that follows, however late, is that same gesture and must not reopen it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayViewSpec } from '../overlay-view.js'
import { CLOSE_LIKE_POPUP } from '../overlay-types.js'
import type { OverlayDef } from '../overlay-types.js'

const { views, placed } = vi.hoisted(() => ({ views: [] as Array<{ onBlur: () => void }>, placed: [] as Array<{ x: number, width: number }> }))

vi.mock('../overlay-view.js', () => ({
  focusedContents: () => undefined,
  createOverlayView: (spec: OverlayViewSpec) => {
    views.push({ onBlur: spec.onBlur })
    return {
      id: 100 + views.length,
      attach: () => {},
      detach: () => {},
      setBounds: (rect: { x: number, width: number }) => { placed.push(rect) },
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
    views[0]?.onBlur()
    // The press is stamped when its message reaches main, a moment after the focus change that closed the overlay.
    vi.advanceTimersByTime(8)
    const pressedAt = Date.now()
    vi.advanceTimersByTime(1_000)
    host.toggle('a', ANCHOR, undefined, pressedAt)
    expect(host.isOpen('a')).toBe(false)
  })

  it('a quick second click after the close is a new request: its press came after the close', () => {
    const host = setup()
    host.show('a', ANCHOR)
    views[0]?.onBlur()
    vi.advanceTimersByTime(120)
    host.toggle('a', ANCHOR, undefined, Date.now() - 20)
    expect(host.isOpen('a')).toBe(true)
  })

  it('a press that came long after the close opens the overlay however soon the click follows', () => {
    const host = setup()
    host.show('a', ANCHOR)
    views[0]?.onBlur()
    vi.advanceTimersByTime(4_000)
    host.toggle('a', ANCHOR, undefined, Date.now() - 30)
    expect(host.isOpen('a')).toBe(true)
  })

  it('a click with no press (a key) keeps the debounce', () => {
    const host = setup()
    host.show('a', ANCHOR)
    views[0]?.onBlur()
    vi.advanceTimersByTime(100)
    host.toggle('a', ANCHOR)
    expect(host.isOpen('a')).toBe(false)
    vi.advanceTimersByTime(300)
    host.toggle('a', ANCHOR)
    expect(host.isOpen('a')).toBe(true)
  })

  it('leaves an overlay open on a toggle while its handler holds it, and closes it once it no longer does', () => {
    let holding = true
    const held = { ...DEF, name: 'held', attach: () => ({ request: () => undefined, holdsOnToggle: () => holding }) } as OverlayDef
    const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => true }
    const host = createOverlayHost({
      win: win as never,
      contentView: {} as never,
      dirname: '/app',
      defs: [held],
      context: () => ({ window: { chrome: { webContents: { id: 5 } } }, services: { windows: { all: () => [{ window: win }] } } }) as never,
      area: () => ({ x: 0, y: 76, width: 1200, height: 724 }),
      activeContents: () => undefined
    })
    host.show('held', ANCHOR)
    host.toggle('held', ANCHOR)
    expect(host.isOpen('held')).toBe(true)
    holding = false
    host.toggle('held', ANCHOR)
    expect(host.isOpen('held')).toBe(false)
  })

  it('counts an adopted panel that is open as a popup, as well as its own popup overlays', () => {
    const host = setup()
    let panelOpen = false
    host.adopt({ close: () => { panelOpen = false }, isOpen: () => panelOpen })
    expect(host.popupOpen()).toBe(false)
    panelOpen = true
    expect(host.popupOpen()).toBe(true)
    panelOpen = false
    host.show('a', ANCHOR)
    expect(host.popupOpen()).toBe(true)
  })

  it('places an open overlay under its anchor again when the anchor moves, and ignores a closed one', () => {
    const host = setup()
    host.reanchor('a', { x: 10, y: 10, width: 10, height: 10 })
    expect(host.isOpen('a')).toBe(false)
    host.show('a', ANCHOR)
    expect(() => { host.reanchor('a', { x: 100, y: 40, width: 30, height: 30 }) }).not.toThrow()
    expect(host.isOpen('a')).toBe(true)
  })

  it('places a sheet in the pane of the tab in front when the area is split', () => {
    const sheet = { ...DEF, name: 'sheet', placement: { kind: 'area', at: 'center', width: 400 }, layer: 'bar', closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false } } as OverlayDef
    const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => true }
    const host = createOverlayHost({
      win: win as never,
      contentView: { addChildView: () => {} } as never,
      dirname: '/app',
      defs: [sheet],
      context: () => ({ window: { chrome: { webContents: { id: 5 } } }, services: { windows: { all: () => [{ window: win }] } } }) as never,
      area: () => ({ x: 0, y: 76, width: 1200, height: 724 }),
      paneArea: () => ({ x: 600, y: 76, width: 600, height: 724 }),
      activeContents: () => undefined
    })
    host.show('sheet')
    expect(host.isOpen('sheet')).toBe(true)
    expect(placed.at(-1)).toMatchObject({ x: 700, width: 400 })
  })
})

