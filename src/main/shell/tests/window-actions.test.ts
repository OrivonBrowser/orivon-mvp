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
    area: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    reachChrome: vi.fn()
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
    expect(toggle).toHaveBeenCalledExactlyOnceWith('menu', anchor, undefined, undefined)
    for (const bad of [undefined, null, 'x', { x: Number.NaN, y: 1, width: 2, height: 3 }, { x: 1, y: 1, width: 2 }]) actions.openMenu(bad as never)
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})

describe('shellActions press', () => {
  it('stamps the press with the window\'s clock and gives it to the next click on that button, once', () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    try {
      const toggle = vi.fn()
      const sitePanel = { close: vi.fn(), toggle: vi.fn() }
      const parts = makeParts({})
      ;(parts.entry as unknown as { overlays: unknown }).overlays = { toggle }
      ;(parts.panels as unknown as { siteInfo: unknown }).siteInfo = sitePanel
      const actions = shellActions(parts)
      const anchor = { x: 900, y: 40, width: 30, height: 30 }

      actions.press('menu')
      vi.advanceTimersByTime(1_200)
      actions.openMenu(anchor)
      actions.openMenu(anchor)
      expect(toggle).toHaveBeenNthCalledWith(1, 'menu', anchor, undefined, 50_000)
      expect(toggle).toHaveBeenNthCalledWith(2, 'menu', anchor, undefined, undefined)

      actions.press('web3')
      actions.openSiteInfo(anchor, 'main', 'https://app.example/')
      actions.openSiteInfo(anchor, 'web3', 'https://app.example/')
      expect(sitePanel.toggle).toHaveBeenNthCalledWith(1, anchor, 'https://app.example', 'main', undefined)
      expect(sitePanel.toggle).toHaveBeenNthCalledWith(2, anchor, 'https://app.example', 'web3', 51_200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the all-sites popup its own stamp', () => {
    const permissions = { close: vi.fn(), toggle: vi.fn() }
    const parts = makeParts({})
    ;(parts.panels as unknown as { permissions: unknown }).permissions = permissions
    const actions = shellActions(parts)
    const anchor = { x: 800, y: 40, width: 30, height: 30 }

    actions.press('permissions')
    actions.openPermissions(anchor, undefined)
    expect(permissions.toggle).toHaveBeenCalledExactlyOnceWith(anchor, undefined, expect.any(Number))
  })
})
