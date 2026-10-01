import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayViewSpec } from '../overlay-view.js'
import type { OverlayDef } from '../overlay-types.js'

interface FakeView { id: number, spec: OverlayViewSpec, bounds: unknown, log: string[] }
const { views } = vi.hoisted(() => ({ views: [] as FakeView[] }))

vi.mock('../overlay-view.js', () => ({
  focusedContents: () => undefined,
  createOverlayView: (spec: OverlayViewSpec) => {
    const view: FakeView = { id: 100 + views.length, spec, bounds: null, log: [] }
    views.push(view)
    return {
      id: view.id,
      attach: () => { view.log.push('attach') },
      detach: () => { view.log.push('detach') },
      setBounds: (bounds: unknown) => { view.bounds = bounds },
      focusWhenReady: () => {},
      send: () => {},
      refreshBackground: () => {},
      isDestroyed: () => false,
      destroy: () => { view.log.push('destroy') }
    }
  }
}))
vi.mock('../../shell/theme-colors.js', () => ({ onThemeUpdated: () => () => {} }))

const { createOverlayHost } = await import('../overlay-host.js')

const AREA = { current: { x: 0, y: 76, width: 840, height: 724 } }

function dock (handler: Partial<ReturnType<OverlayDef['attach']>> = {}): OverlayDef {
  return {
    name: 'dock', placement: { kind: 'dock' }, surface: 'panel', focus: 'take', layer: 'bar',
    closeOn: { blur: false, tabSwitch: false, navigation: false, layout: false }, keep: 'warm',
    attach: () => ({ request: () => undefined, ...handler })
  }
}

function setup (def: OverlayDef): ReturnType<typeof createOverlayHost> {
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => true }
  return createOverlayHost({
    win: win as never, contentView: {} as never, dirname: '/app', defs: [def],
    context: () => ({ window: { chrome: { webContents: { id: 5 } } }, services: { windows: { all: () => [{ window: win }] } } }) as never,
    area: () => AREA.current, activeContents: () => undefined
  })
}

beforeEach(() => { AREA.current = { x: 0, y: 76, width: 840, height: 724 } })
afterEach(() => { views.length = 0 })

describe('createOverlayHost: a dock', () => {
  it('sits in the strip the page area leaves, whatever height its content asks for', () => {
    const host = setup(dock())
    host.show('dock')
    expect(views[0]?.bounds).toEqual({ x: 840, y: 76, width: 360, height: 724 })
    views[0]?.spec.port.size(90)
    expect(views[0]?.bounds).toEqual({ x: 840, y: 76, width: 360, height: 724 })
  })

  it('is built without rounded corners', () => {
    setup(dock()).show('dock')
    expect(views[0]?.spec.square).toBe(true)
  })

  it('is not closed by closing the popups, a layout change, or a tab switch, and follows the page area', () => {
    const host = setup(dock())
    host.show('dock')
    host.close()
    host.tabSwitched()
    host.navigated()
    AREA.current = { x: 360, y: 104, width: 840, height: 696 }
    host.relayout()

    expect(host.isOpen('dock')).toBe(true)
    expect(views[0]?.bounds).toEqual({ x: 0, y: 104, width: 360, height: 696 })
  })

  it('tells the overlay after it repositions it, and not when it is closed', () => {
    const moved = vi.fn()
    const host = setup(dock({ moved }))
    host.relayout()
    expect(moved).not.toHaveBeenCalled()
    host.show('dock')
    host.relayout()
    expect(moved).toHaveBeenCalledTimes(1)
    host.close('dock')
    host.relayout()
    expect(moved).toHaveBeenCalledTimes(1)
  })

  it('survives an overlay whose moved hook throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = setup(dock({ moved: () => { throw new Error('boom') } }))
    host.show('dock')
    expect(() => { host.relayout() }).not.toThrow()
    error.mockRestore()
  })

  it('keeps an adopted panel standing through a relayout that closes the panels', () => {
    const host = setup(dock())
    const restack = vi.fn()
    const close = vi.fn()
    host.adopt({ close }, restack)
    host.show('dock')
    host.restack()
    expect(restack).toHaveBeenCalled()
  })
})
