// A key typed in an overlay's page reaches its handler before the page does, and the handler may drop it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverlayViewSpec } from '../overlay-view.js'
import { CLOSE_LIKE_POPUP } from '../overlay-types.js'
import type { OverlayDef, OverlayHandler } from '../overlay-types.js'

const { specs } = vi.hoisted(() => ({ specs: [] as unknown[] }))

vi.mock('../overlay-view.js', () => ({
  focusedContents: () => undefined,
  createOverlayView: (spec: OverlayViewSpec) => {
    specs.push(spec)
    return {
      id: 100 + specs.length,
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

function setup (handler: Partial<OverlayHandler>): ReturnType<typeof createOverlayHost> {
  const def = {
    name: 'a', placement: { kind: 'anchor', width: 380, align: 'right' }, surface: 'panel', focus: 'take', layer: 'popup',
    closeOn: CLOSE_LIKE_POPUP, keep: 'warm', attach: () => ({ request: () => undefined, ...handler })
  } as OverlayDef
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => true }
  return createOverlayHost({
    win: win as never,
    contentView: {} as never,
    dirname: '/app',
    defs: [def],
    context: () => ({ window: { chrome: { webContents: { id: 5 } } }, services: { windows: { all: () => [{ window: win }] } } }) as never,
    area: () => ({ x: 0, y: 76, width: 1200, height: 724 }),
    activeContents: () => undefined
  })
}

const onKey = (): NonNullable<OverlayViewSpec['onKey']> => (specs[0] as OverlayViewSpec).onKey as NonNullable<OverlayViewSpec['onKey']>

afterEach(() => { specs.length = 0 })

describe('createOverlayHost: keys typed in an overlay', () => {
  it('reach the handler, which may drop them', () => {
    const key = vi.fn((input: { key: string }) => input.key === 'Enter')
    setup({ key }).show('a', ANCHOR)
    expect(onKey()({ key: 'Tab', isAutoRepeat: false })).toBe(false)
    expect(onKey()({ key: 'Enter', isAutoRepeat: true })).toBe(true)
    expect(key).toHaveBeenCalledTimes(2)
  })

  it('are not dropped when the handler has no say', () => {
    setup({}).show('a', ANCHOR)
    expect(onKey()({ key: 'Enter', isAutoRepeat: true })).toBe(false)
  })

  it('are not dropped when the overlay is not open', () => {
    const key = vi.fn(() => true)
    const host = setup({ key })
    host.prewarm('a')
    expect(onKey()({ key: 'Enter', isAutoRepeat: true })).toBe(false)
    expect(key).not.toHaveBeenCalled()
  })
})
