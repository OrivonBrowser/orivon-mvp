import { afterEach, describe, expect, it, vi } from 'vitest'
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
      hide: () => { view.log.push('hide') },
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

function exact (closeOn: Partial<OverlayDef['closeOn']> = {}): OverlayDef {
  return {
    name: 'exact', placement: { kind: 'exact', radius: 6 }, surface: 'panel', focus: 'never', layer: 'bar',
    closeOn: { blur: false, tabSwitch: true, navigation: true, layout: true, ...closeOn }, keep: 'resident',
    attach: () => ({ request: () => undefined })
  }
}

function setup (def: OverlayDef = exact()): ReturnType<typeof createOverlayHost> {
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => true }
  return createOverlayHost({
    win: win as never, contentView: {} as never, dirname: '/app', defs: [def],
    context: () => ({ window: { chrome: { webContents: { id: 5 } } }, services: { windows: { all: () => [{ window: win }] } } }) as never,
    area: () => ({ x: 0, y: 76, width: 1200, height: 724 }), activeContents: () => undefined
  })
}

afterEach(() => { views.length = 0 })

describe('createOverlayHost: an exact place', () => {
  it('sits where the feature says, when it is shown and when it is moved', () => {
    const host = setup()
    host.show('exact', { x: -6, y: 776, width: 0, height: 0 })
    expect(views[0]?.bounds).toEqual({ x: -6, y: 776, width: 0, height: 0 })

    host.reanchor('exact', { x: -6, y: 776, width: 206, height: 30 })
    expect(views[0]?.bounds).toEqual({ x: -6, y: 776, width: 206, height: 30 })
  })

  it('has the corner radius the definition names', () => {
    setup().show('exact', { x: 0, y: 0, width: 10, height: 10 })
    expect(views[0]?.spec.radius).toBe(6)
  })

  it('ignores the height its page reports', () => {
    const host = setup()
    host.show('exact', { x: 0, y: 776, width: 200, height: 24 })
    views[0]?.spec.port.size(300)
    expect(views[0]?.bounds).toEqual({ x: 0, y: 776, width: 200, height: 24 })
  })

  it('stays a hidden child of its window between shows, and takes its place again when shown', async () => {
    const host = setup()
    host.show('exact', { x: 0, y: 776, width: 200, height: 24 })
    await views[0]?.spec.port.ready()
    host.close('exact')
    host.show('exact', { x: 1000, y: 776, width: 200, height: 24 })

    expect(views).toHaveLength(1)
    expect(views[0]?.log).not.toContain('detach')
    expect(views[0]?.log).not.toContain('destroy')
    expect(views[0]?.log).toContain('hide')
    expect(views[0]?.bounds).toEqual({ x: 1000, y: 776, width: 200, height: 24 })
  })

  it('closes on a resize, a tab switch and a navigation when its definition says so', () => {
    for (const close of [(h: ReturnType<typeof setup>) => { h.relayout() }, (h: ReturnType<typeof setup>) => { h.tabSwitched() }, (h: ReturnType<typeof setup>) => { h.navigated() }]) {
      const host = setup()
      host.show('exact', { x: 0, y: 776, width: 200, height: 24 })
      close(host)
      expect(host.isOpen('exact')).toBe(false)
    }
  })

  it('is not closed by closing the popups', () => {
    const host = setup()
    host.show('exact', { x: 0, y: 776, width: 200, height: 24 })
    host.close()
    expect(host.isOpen('exact')).toBe(true)
  })
})
