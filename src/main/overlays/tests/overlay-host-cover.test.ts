// A cover is a `pane` overlay on the `cover` layer: it fills the page area, lies under every bar, adopted panel and
// popup however it was shown, and is not a popup.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayViewSpec } from '../overlay-view.js'
import { CLOSE_LIKE_BAR, CLOSE_LIKE_POPUP } from '../overlay-types.js'
import type { OverlayDef } from '../overlay-types.js'

interface FakeView { name: string, spec: OverlayViewSpec, bounds: unknown }

const { views, attachOrder } = vi.hoisted(() => ({ views: [] as FakeView[], attachOrder: [] as string[] }))

vi.mock('../overlay-view.js', () => ({
  focusedContents: () => undefined,
  createOverlayView: (spec: OverlayViewSpec) => {
    const view: FakeView = { name: spec.def.name, spec, bounds: null }
    views.push(view)
    return {
      id: 100 + views.length,
      attach: () => { attachOrder.push(view.name) },
      detach: () => {},
      hide: () => {},
      setBounds: (bounds: unknown) => { view.bounds = bounds },
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

const PANE = { current: { x: 600, y: 104, width: 600, height: 696 } }
const AREA = { x: 0, y: 104, width: 1200, height: 696 }

const cover: OverlayDef = {
  name: 'cover', placement: { kind: 'pane' }, surface: 'page', focus: 'never', layer: 'cover',
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false }, keep: 'warm',
  attach: () => ({ request: () => undefined })
}
const bar: OverlayDef = {
  name: 'bar', placement: { kind: 'area', at: 'top-right', width: 300 }, surface: 'panel', focus: 'never', layer: 'bar',
  closeOn: CLOSE_LIKE_BAR, keep: 'warm', attach: () => ({ request: () => undefined })
}
const popup: OverlayDef = {
  name: 'popup', placement: { kind: 'anchor', width: 300, align: 'right' }, surface: 'menu', focus: 'never', layer: 'popup',
  closeOn: CLOSE_LIKE_POPUP, keep: 'warm', attach: () => ({ request: () => undefined })
}

function setup (): ReturnType<typeof createOverlayHost> {
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => true }
  return createOverlayHost({
    win: win as never, contentView: {} as never, dirname: '/app', defs: [cover, bar, popup],
    context: () => ({ window: { chrome: { webContents: { id: 5 } } }, services: { windows: { all: () => [{ window: win }] } } }) as never,
    area: () => AREA, paneArea: () => PANE.current, activeContents: () => undefined
  })
}

/** Page ready for every view built so far, so each open overlay has joined its window. */
async function ready (): Promise<void> {
  for (const view of views) await view.spec.port.ready()
}

const viewOf = (name: string): FakeView | undefined => views.find((view) => view.name === name)

beforeEach(() => { PANE.current = { x: 600, y: 104, width: 600, height: 696 } })
afterEach(() => { views.length = 0; attachOrder.length = 0 })

describe('createOverlayHost: a cover', () => {
  it('fills the pane of the tab in front, with square corners, and ignores the height its page reports', () => {
    const host = setup()
    host.show('cover')
    expect(viewOf('cover')?.bounds).toEqual({ x: 600, y: 104, width: 600, height: 696 })
    expect(viewOf('cover')?.spec.square).toBe(true)
    viewOf('cover')?.spec.port.size(90)
    expect(viewOf('cover')?.bounds).toEqual({ x: 600, y: 104, width: 600, height: 696 })
  })

  it('follows the pane when the window is laid out again, and survives it', () => {
    const host = setup()
    host.show('cover')
    PANE.current = { x: 0, y: 76, width: 1200, height: 724 }
    host.relayout()
    expect(host.isOpen('cover')).toBe(true)
    expect(viewOf('cover')?.bounds).toEqual({ x: 0, y: 76, width: 1200, height: 724 })
  })

  it('lies under a bar shown after it, and under one shown before it once it joins', async () => {
    const host = setup()
    host.show('bar')
    host.show('cover')
    await ready()
    host.restack()
    expect(attachOrder.slice(-2)).toEqual(['cover', 'bar'])

    attachOrder.length = 0
    host.show('cover')
    host.show('bar')
    host.restack()
    expect(attachOrder.slice(-2)).toEqual(['cover', 'bar'])
  })

  it('lies under a bar even when its page becomes ready after the bar joined', async () => {
    const host = setup()
    host.show('bar')
    await viewOf('bar')?.spec.port.ready()
    host.show('cover')
    attachOrder.length = 0
    await viewOf('cover')?.spec.port.ready()
    expect(attachOrder.slice(-2)).toEqual(['cover', 'bar'])
  })

  it('lies under a popup and under an adopted panel', async () => {
    const host = setup()
    const panelRestack = vi.fn(() => { attachOrder.push('panel') })
    host.adopt({ close: () => {} }, panelRestack)
    host.show('popup')
    host.show('cover')
    await ready()
    host.restack()
    expect(attachOrder.slice(-3)).toEqual(['cover', 'panel', 'popup'])
  })

  it('is not a popup: showing it keeps the popups open, and closing the popups keeps it', async () => {
    const host = setup()
    host.show('popup')
    host.show('cover')
    expect(host.isOpen('popup')).toBe(true)
    expect(host.popupOpen()).toBe(true)
    host.close()
    expect(host.isOpen('cover')).toBe(true)
    expect(host.isOpen('popup')).toBe(false)
    host.show('popup')
    host.close('popup')
    expect(host.popupOpen()).toBe(false)
    expect(host.isOpen('cover')).toBe(true)
    host.closeOverlays()
    expect(host.isOpen('cover')).toBe(true)
  })

  it('closes on a tab switch', () => {
    const host = setup()
    host.show('cover')
    host.tabSwitched()
    expect(host.isOpen('cover')).toBe(false)
  })
})
