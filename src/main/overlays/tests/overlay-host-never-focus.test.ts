// A `never` overlay joins its window once its page has committed: a view attached before that takes the keyboard from
// whatever held it, as the page commits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayViewSpec } from '../overlay-view.js'
import { CLOSE_LIKE_BAR, CLOSE_LIKE_POPUP } from '../overlay-types.js'
import type { OverlayDef } from '../overlay-types.js'

interface FakeView { spec: OverlayViewSpec, log: string[] }

const { views } = vi.hoisted(() => ({ views: [] as FakeView[] }))

vi.mock('../overlay-view.js', () => ({
  focusedContents: () => undefined,
  createOverlayView: (spec: OverlayViewSpec) => {
    const view: FakeView = { spec, log: [] }
    views.push(view)
    return {
      id: 100 + views.length,
      attach: () => { view.log.push('attach') },
      detach: () => { view.log.push('detach') },
      hide: () => { view.log.push('hide') },
      setBounds: () => {},
      focusWhenReady: () => { view.log.push('focus') },
      send: () => {},
      refreshBackground: () => {},
      isDestroyed: () => false,
      destroy: () => { view.log.push('destroy') }
    }
  }
}))
vi.mock('../../shell/theme-colors.js', () => ({ onThemeUpdated: () => () => {} }))

const { createOverlayHost } = await import('../overlay-host.js')

const ANCHOR = { x: 900, y: 40, width: 30, height: 30 }

function def (name: string, patch: Partial<OverlayDef> = {}): OverlayDef {
  return {
    name, placement: { kind: 'anchor', width: 380, align: 'right' }, surface: 'panel', focus: 'never', layer: 'popup',
    closeOn: CLOSE_LIKE_POPUP, keep: 'resident', attach: () => ({ request: () => undefined }),
    ...patch
  } as OverlayDef
}

function setup (defs: OverlayDef[]): ReturnType<typeof createOverlayHost> {
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => true }
  return createOverlayHost({
    win: win as never,
    contentView: {} as never,
    dirname: '/app',
    defs,
    context: () => ({ window: { chrome: { webContents: { id: 5 } } }, services: { windows: { all: () => [{ window: win }] } } }) as never,
    area: () => ({ x: 0, y: 76, width: 1200, height: 724 }),
    activeContents: () => undefined
  })
}

/** How many times the view was put in the window: a show attaches and then restacks, so more than one is one join. */
const attaches = (index: number): number => views[index]?.log.filter((entry) => entry === 'attach').length ?? 0

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => { vi.useRealTimers(); views.length = 0 })

describe('createOverlayHost: a never overlay joins the window once its page is ready', () => {
  it('attaches nothing before the page is ready, and attaches when it is', async () => {
    const host = setup([def('o')])
    host.show('o', ANCHOR)
    expect(host.isOpen('o')).toBe(true)
    expect(attaches(0)).toBe(0)
    const reply = views[0]?.spec.port.ready()
    expect(attaches(0)).toBeGreaterThan(0)
    await reply
  })

  it('never attaches an overlay that closed before its page was ready', async () => {
    const host = setup([def('o')])
    host.show('o', ANCHOR)
    host.close('o')
    await views[0]?.spec.port.ready()
    expect(attaches(0)).toBe(0)
    expect(host.isOpen('o')).toBe(false)
  })

  it('does not attach it early when another overlay restacks the window', async () => {
    const host = setup([def('o', { layer: 'bar', closeOn: CLOSE_LIKE_BAR }), def('p', { focus: 'take', keep: 'fresh' })])
    host.show('o', ANCHOR)
    host.show('p', ANCHOR)
    host.restack()
    expect(attaches(0)).toBe(0)
    await views[0]?.spec.port.ready()
    expect(attaches(0)).toBeGreaterThan(0)
  })

  it('attaches a take overlay at show', () => {
    const host = setup([def('t', { focus: 'take', keep: 'fresh' })])
    host.show('t', ANCHOR)
    expect(attaches(0)).toBeGreaterThan(0)
  })

  it('attaches a never overlay whose page is already ready at show', async () => {
    const host = setup([def('o')])
    host.show('o', ANCHOR)
    await views[0]?.spec.port.ready()
    host.close('o')
    const before = attaches(0)
    host.show('o', ANCHOR)
    expect(attaches(0)).toBeGreaterThan(before)
  })

  it('attaches once per show: a second ready does not attach again', async () => {
    const host = setup([def('o')])
    host.show('o', ANCHOR)
    await views[0]?.spec.port.ready()
    const once = attaches(0)
    await views[0]?.spec.port.ready()
    expect(once).toBeGreaterThan(0)
    expect(attaches(0)).toBe(once)
  })

  it('does not attach a view the renderer lost before its page was ready', async () => {
    const host = setup([def('o')])
    host.show('o', ANCHOR)
    views[0]?.spec.onGone()
    await views[0]?.spec.port.ready()
    expect(attaches(0)).toBe(0)
    expect(host.isOpen('o')).toBe(false)
  })
})
