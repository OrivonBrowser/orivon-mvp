import { describe, expect, it, vi } from 'vitest'
import { shellActions } from '../window-actions.js'
import type { WindowParts } from '../window-actions.js'

function makeParts (window: unknown): WindowParts {
  const entry = { window, chrome: {}, tabs: {}, overlays: {}, shortcutsSuspended: () => false }
  return {
    entry: entry as never,
    services: {} as never,
    panels: { networks: { close: vi.fn() }, siteInfo: { close: vi.fn() } } as never,
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

  it('gives the Available networks popup its own stamp', () => {
    const networks = { close: vi.fn(), toggle: vi.fn() }
    const parts = makeParts({})
    ;(parts.panels as unknown as { networks: unknown }).networks = networks
    const actions = shellActions(parts)
    const anchor = { x: 800, y: 40, width: 30, height: 30 }

    actions.press('networks')
    actions.openNetworks(anchor)
    expect(networks.toggle).toHaveBeenCalledExactlyOnceWith(anchor, expect.any(Number))
  })
})

describe('shellActions openSiteInfo for the tunnel button', () => {
  const anchor = { x: 900, y: 40, width: 30, height: 30 }
  function partsWith (tabs: unknown[], activeTabId: string | null): { actions: ReturnType<typeof shellActions>, sitePanel: { close: ReturnType<typeof vi.fn>, toggle: ReturnType<typeof vi.fn>, toggleTab: ReturnType<typeof vi.fn> }, closeOverlays: ReturnType<typeof vi.fn> } {
    const sitePanel = { close: vi.fn(), toggle: vi.fn(), toggleTab: vi.fn() }
    const parts = makeParts({})
    ;(parts.entry as unknown as { tabs: unknown }).tabs = { getState: () => ({ tabs, activeTabId }) }
    ;(parts.panels as unknown as { siteInfo: unknown }).siteInfo = sitePanel
    return { actions: shellActions(parts), sitePanel, closeOverlays: parts.closeOverlays as unknown as ReturnType<typeof vi.fn> }
  }

  it('opens the popover for the new tab in front, with no address to be about', () => {
    const { actions, sitePanel, closeOverlays } = partsWith([{ id: 't1', isNewTab: true, isInternal: false }], 't1')
    actions.openSiteInfo(anchor, 'tunnels')
    expect(sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
    expect(sitePanel.toggle).not.toHaveBeenCalled()
    expect(closeOverlays).toHaveBeenCalled()
  })

  it('opens it for the tab when the page shown is a website of a tab with a choice, and for the website when the tab has none', () => {
    const withChoice = partsWith([{ id: 't1', isNewTab: false, isInternal: false, tunnelChoice: 'nym' }], 't1')
    withChoice.actions.openSiteInfo(anchor, 'tunnels', 'https://news.example/a')
    expect(withChoice.sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
    const plain = partsWith([{ id: 't1', isNewTab: false, isInternal: false }], 't1')
    plain.actions.openSiteInfo(anchor, 'tunnels', 'https://news.example/a')
    expect(plain.sitePanel.toggleTab).not.toHaveBeenCalled()
    expect(plain.sitePanel.toggle).toHaveBeenCalledExactlyOnceWith(anchor, 'https://news.example', 'tunnels', undefined)
  })

  it('never opens the tab\'s popover for the shield or the key, which are about the page', () => {
    const { actions, sitePanel } = partsWith([{ id: 't1', isNewTab: true, isInternal: false }], 't1')
    actions.openSiteInfo(anchor, 'main')
    actions.openSiteInfo(anchor, 'web3')
    expect(sitePanel.toggleTab).not.toHaveBeenCalled()
    expect(sitePanel.toggle).not.toHaveBeenCalled()
  })
})
