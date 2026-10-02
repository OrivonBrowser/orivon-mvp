import { describe, expect, it, vi } from 'vitest'
import { shellActions } from '../window-actions.js'
import type { WindowParts } from '../window-actions.js'

function makeParts (window: unknown): WindowParts {
  const entry = { window, chrome: {}, tabs: {}, overlays: {}, shortcutsSuspended: () => false }
  return {
    entry: entry as never,
    services: {} as never,
    panels: { permissions: { close: vi.fn() }, siteInfo: { close: vi.fn() } } as never,
    closeOverlays: vi.fn(),
    openWindow: vi.fn(),
    topHeight: 0,
    area: () => ({ x: 0, y: 0, width: 0, height: 0 })
  }
}

describe('shellActions openMenu', () => {
  it('toggles the menu under a rectangle of numbers, and ignores any other anchor', () => {
    const toggle = vi.fn()
    const parts = makeParts({})
    ;(parts.entry as unknown as { overlays: unknown }).overlays = { toggle }
    const actions = shellActions(parts)
    const anchor = { x: 900, y: 40, width: 30, height: 30 }
    actions.openMenu(anchor)
    expect(toggle).toHaveBeenCalledExactlyOnceWith('menu', anchor)
    for (const bad of [undefined, null, 'x', { x: Number.NaN, y: 1, width: 2, height: 3 }, { x: 1, y: 1, width: 2 }]) actions.openMenu(bad as never)
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})
