// What a closed overlay leaves in its window: a warm view stays, hidden, so the next show only shows it again, and a view
// that is about to be destroyed leaves first. A view removed and added back would stay hidden (README.md, Design notes).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayViewSpec } from '../overlay-view.js'
import { CLOSE_LIKE_POPUP } from '../overlay-types.js'
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

const ANCHOR = { x: 900, y: 40, width: 30, height: 30 }

function def (keep: 'warm' | 'fresh'): OverlayDef {
  return {
    name: 'a', placement: { kind: 'anchor', width: 380, align: 'right' }, surface: 'panel', focus: 'take', layer: 'popup',
    closeOn: CLOSE_LIKE_POPUP, keep, attach: () => ({ request: () => undefined })
  } as OverlayDef
}

function setup (keep: 'warm' | 'fresh'): ReturnType<typeof createOverlayHost> {
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => true }
  return createOverlayHost({
    win: win as never,
    contentView: {} as never,
    dirname: '/app',
    defs: [def(keep)],
    context: () => ({ window: { chrome: { webContents: { id: 5 } } }, services: { windows: { all: () => [{ window: win }] } } }) as never,
    area: () => ({ x: 0, y: 76, width: 1200, height: 724 }),
    activeContents: () => undefined
  })
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => { vi.useRealTimers(); views.length = 0 })

describe('createOverlayHost: what a closed overlay leaves in the window', () => {
  it('hides a warm view in place on close and shows the same view again on the next show', () => {
    const host = setup('warm')
    host.show('a', ANCHOR)
    host.close('a')
    expect(views[0]?.log).toContain('hide')
    expect(views[0]?.log).not.toContain('detach')
    const hidden = views[0]?.log.length ?? 0
    host.show('a', ANCHOR)
    expect(views).toHaveLength(1)
    expect(views[0]?.log.slice(hidden)).toContain('attach')
  })

  it('takes a fresh view out of the window before it destroys it', () => {
    const host = setup('fresh')
    host.show('a', ANCHOR)
    host.close('a')
    const log = views[0]?.log ?? []
    expect(log).not.toContain('hide')
    expect(log.indexOf('detach')).toBeGreaterThan(-1)
    expect(log.indexOf('detach')).toBeLessThan(log.indexOf('destroy'))
  })

  it('takes a warm view whose renderer died out of the window before it destroys it', () => {
    const host = setup('warm')
    host.show('a', ANCHOR)
    views[0]?.spec.onGone()
    const log = views[0]?.log ?? []
    expect(log.indexOf('detach')).toBeGreaterThan(-1)
    expect(log.indexOf('detach')).toBeLessThan(log.indexOf('destroy'))
  })
})
