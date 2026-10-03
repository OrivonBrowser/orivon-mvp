// A `warm` overlay's view is given back after a minute closed; a `resident` one is never, and a `fresh` one goes at once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayViewSpec } from '../overlay-view.js'
import { CLOSE_LIKE_POPUP } from '../overlay-types.js'
import type { OverlayDef } from '../overlay-types.js'

interface FakeView { id: number, destroyed: boolean, spec: OverlayViewSpec }

const { views } = vi.hoisted(() => ({ views: [] as FakeView[] }))

vi.mock('../overlay-view.js', () => ({
  focusedContents: () => undefined,
  createOverlayView: (spec: OverlayViewSpec) => {
    const view: FakeView = { id: 100 + views.length, destroyed: false, spec }
    views.push(view)
    return {
      id: view.id,
      attach: () => {},
      detach: () => {},
      hide: () => {},
      setBounds: () => {},
      focusWhenReady: () => {},
      send: () => {},
      refreshBackground: () => {},
      isDestroyed: () => view.destroyed,
      destroy: () => { view.destroyed = true }
    }
  }
}))
vi.mock('../../shell/theme-colors.js', () => ({ onThemeUpdated: () => () => {} }))

const { createOverlayHost } = await import('../overlay-host.js')

const ANCHOR = { x: 900, y: 40, width: 30, height: 30 }
const MINUTE = 60_000

function def (name: string, keep: OverlayDef['keep']): OverlayDef {
  return {
    name, placement: { kind: 'anchor', width: 380, align: 'right' }, surface: 'panel', focus: 'take', layer: 'popup',
    closeOn: CLOSE_LIKE_POPUP, keep, attach: () => ({ request: () => undefined })
  } as OverlayDef
}

function setup (...defs: OverlayDef[]): ReturnType<typeof createOverlayHost> {
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

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); views.length = 0 })

describe('createOverlayHost: an idle warm overlay', () => {
  it('keeps its view for a minute after it closes and destroys it then', () => {
    const host = setup(def('w', 'warm'))
    host.show('w', ANCHOR)
    host.close('w')
    vi.advanceTimersByTime(MINUTE - 1)
    expect(views[0]?.destroyed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(views[0]?.destroyed).toBe(true)
  })

  it('builds a new view for the next show after it was given back', () => {
    const host = setup(def('w', 'warm'))
    host.show('w', ANCHOR)
    host.close('w')
    vi.advanceTimersByTime(MINUTE)
    host.show('w', ANCHOR)
    expect(views).toHaveLength(2)
    expect(views[1]?.destroyed).toBe(false)
    expect(host.isOpen('w')).toBe(true)
  })

  it('keeps its view when shown again before the minute is up, and counts a new minute from the next close', () => {
    const host = setup(def('w', 'warm'))
    host.show('w', ANCHOR)
    host.close('w')
    vi.advanceTimersByTime(MINUTE - 1000)
    host.show('w', ANCHOR)
    vi.advanceTimersByTime(5 * MINUTE)
    expect(views).toHaveLength(1)
    expect(views[0]?.destroyed).toBe(false)
    expect(host.isOpen('w')).toBe(true)

    host.close('w')
    vi.advanceTimersByTime(MINUTE - 1)
    expect(views[0]?.destroyed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(views[0]?.destroyed).toBe(true)
  })

  it('does not destroy a view that is open again when an old countdown would have ended', () => {
    const host = setup(def('w', 'warm'))
    host.show('w', ANCHOR)
    host.close('w')
    vi.advanceTimersByTime(30_000)
    host.show('w', ANCHOR)
    vi.advanceTimersByTime(MINUTE)
    expect(views[0]?.destroyed).toBe(false)
  })

  it('destroys a view that was prewarmed and never shown after a minute', () => {
    const host = setup(def('w', 'warm'))
    host.prewarm('w')
    expect(views).toHaveLength(1)
    vi.advanceTimersByTime(MINUTE - 1)
    expect(views[0]?.destroyed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(views[0]?.destroyed).toBe(true)
  })

  it('starts the minute over when it is prewarmed again, and keeps the view for a show in between', () => {
    const host = setup(def('w', 'warm'))
    host.prewarm('w')
    vi.advanceTimersByTime(MINUTE - 1000)
    host.prewarm('w')
    vi.advanceTimersByTime(MINUTE - 1000)
    expect(views).toHaveLength(1)
    expect(views[0]?.destroyed).toBe(false)
    host.show('w', ANCHOR)
    vi.advanceTimersByTime(5 * MINUTE)
    expect(views[0]?.destroyed).toBe(false)
  })

  it('does not keep the process alive for the countdown', () => {
    const schedule = vi.spyOn(globalThis, 'setTimeout')
    const host = setup(def('w', 'warm'))
    host.show('w', ANCHOR)
    host.close('w')
    expect(schedule).toHaveBeenCalledTimes(1)
    const timer = schedule.mock.results[0]?.value as { hasRef: () => boolean }
    expect(timer.hasRef()).toBe(false)
  })
})

describe('createOverlayHost: the other modes', () => {
  it('never destroys a resident overlay on idle, shown or prewarmed', () => {
    const host = setup(def('r', 'resident'), def('p', 'resident'))
    host.show('r', ANCHOR)
    host.close('r')
    host.prewarm('p')
    vi.advanceTimersByTime(60 * MINUTE)
    expect(views.map((view) => view.destroyed)).toEqual([false, false])
    expect(vi.getTimerCount()).toBe(0)
    host.show('r', ANCHOR)
    expect(views).toHaveLength(2)
  })

  it('still destroys a fresh overlay the moment it closes, and starts no countdown', () => {
    const host = setup(def('f', 'fresh'))
    host.show('f', ANCHOR)
    host.close('f')
    expect(views[0]?.destroyed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('createOverlayHost: a countdown and the window', () => {
  it('leaves nothing to fire once the host is disposed', () => {
    const host = setup(def('w', 'warm'), def('p', 'warm'))
    host.show('w', ANCHOR)
    host.close('w')
    host.prewarm('p')
    expect(vi.getTimerCount()).toBe(2)
    host.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(views.map((view) => view.destroyed)).toEqual([true, true])
    vi.advanceTimersByTime(MINUTE)
    expect(views).toHaveLength(2)
  })

  it('starts no countdown for an overlay closed by the window going away', () => {
    const host = setup(def('w', 'warm'))
    host.show('w', ANCHOR)
    host.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('forgets the countdown of a view whose renderer died', () => {
    const host = setup(def('w', 'warm'))
    host.show('w', ANCHOR)
    host.close('w')
    views[0]?.spec.onGone()
    expect(vi.getTimerCount()).toBe(0)
    host.show('w', ANCHOR)
    vi.advanceTimersByTime(5 * MINUTE)
    expect(views).toHaveLength(2)
    expect(views[1]?.destroyed).toBe(false)
  })
})
