// A show that throws part-way (a view that cannot take bounds) must leave the overlay closed. A slot left open
// with nothing on screen reads the next toggle as a close, so the overlay could never open again.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverlayViewSpec } from '../overlay-view.js'
import { CLOSE_LIKE_POPUP } from '../overlay-types.js'
import type { OverlayDef } from '../overlay-types.js'

const { views, faults } = vi.hoisted(() => ({ views: [] as Array<{ log: string[] }>, faults: { setBounds: false } }))

vi.mock('../overlay-view.js', () => ({
  focusedContents: () => undefined,
  createOverlayView: (_spec: OverlayViewSpec) => {
    const view = { log: [] as string[] }
    views.push(view)
    return {
      id: 100 + views.length,
      attach: () => { view.log.push('attach') },
      detach: () => { view.log.push('detach') },
      hide: () => { view.log.push('hide') },
      setBounds: () => { if (faults.setBounds) throw new Error('setBounds failed') },
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

afterEach(() => { faults.setBounds = false; views.length = 0 })

describe('createOverlayHost: a show that throws', () => {
  it('leaves the overlay closed, and the next toggle shows it again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = setup()
    faults.setBounds = true
    expect(() => { host.toggle('a', ANCHOR) }).not.toThrow()
    expect(host.isOpen('a')).toBe(false)
    faults.setBounds = false
    host.toggle('a', ANCHOR)
    expect(host.isOpen('a')).toBe(true)
    expect(views.at(-1)?.log).toContain('attach')
  })
})
