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
  /** `keyboardPlaced` false is a tab opened on the start page whose keyboard is still moving: what waits on it runs when `place()` is called. */
  function partsWith (tabs: unknown[], activeTabId: string | null, partition?: string, keyboardPlaced = true, inflightTarget?: string, opener?: unknown): { actions: ReturnType<typeof shellActions>, sitePanel: { close: ReturnType<typeof vi.fn>, toggle: ReturnType<typeof vi.fn>, toggleTab: ReturnType<typeof vi.fn>, holdAgainstArrival: ReturnType<typeof vi.fn> }, closeOverlays: ReturnType<typeof vi.fn>, place: () => void, state: { tabs: unknown[], activeTabId: string | null } } {
    const sitePanel = { close: vi.fn(), toggle: vi.fn(), toggleTab: vi.fn(), holdAgainstArrival: vi.fn() }
    const parts = makeParts({})
    const state = { tabs, activeTabId }
    const waiting: Array<() => void> = []
    const whenPlaced = (_id: string, run: () => void): (() => void) | undefined => {
      if (keyboardPlaced) {
        run()
        return undefined
      }
      waiting.push(run)
      return () => { waiting.splice(waiting.indexOf(run), 1) }
    }
    ;(parts.entry as unknown as { tabs: unknown }).tabs = { getState: () => state, partitionOf: () => partition, record: () => ({ inflightUrl: 'https://start.example/', inflightTarget }), liveWebContents: (id: string) => ({ id, ...(opener === undefined ? {} : { opener }) }), keyboard: { whenPlaced } }
    ;(parts.panels as unknown as { siteInfo: unknown }).siteInfo = sitePanel
    return { actions: shellActions(parts), sitePanel, closeOverlays: parts.closeOverlays as unknown as ReturnType<typeof vi.fn>, place: () => { for (const run of waiting.splice(0)) run() }, state }
  }

  it('opens the popover for the new tab in front, with no address to be about', () => {
    const { actions, sitePanel, closeOverlays } = partsWith([{ id: 't1', isNewTab: true, isInternal: false }], 't1')
    actions.openSiteInfo(anchor, 'tunnels')
    expect(sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
    expect(sitePanel.toggle).not.toHaveBeenCalled()
    expect(closeOverlays).toHaveBeenCalled()
  })

  it('opens it for the tab on every website, whether or not the tab carries a choice', () => {
    const withChoice = partsWith([{ id: 't1', url: 'https://news.example/a', isNewTab: false, isInternal: false, tunnelChoice: 'nym' }], 't1')
    withChoice.actions.openSiteInfo(anchor, 'tunnels', 'https://news.example/a')
    expect(withChoice.sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
    const plain = partsWith([{ id: 't1', url: 'https://news.example/a', isNewTab: false, isInternal: false }], 't1')
    plain.actions.openSiteInfo(anchor, 'tunnels', 'https://news.example/a')
    expect(plain.sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
    expect(plain.sitePanel.toggle).not.toHaveBeenCalled()
  })

  it('opens it for the website a page of this computer is, as a page the tab\'s choice does not reach', () => {
    const { actions, sitePanel } = partsWith([{ id: 't1', url: 'http://localhost:3000/', isNewTab: false, isInternal: false }], 't1')
    actions.openSiteInfo(anchor, 'tunnels', 'http://localhost:3000/')
    expect(sitePanel.toggleTab).not.toHaveBeenCalled()
    expect(sitePanel.toggle).toHaveBeenCalledTimes(1)
  })

  it('opens it for the website when the page is in a session an app or a temporary route made, which keeps its tunnel whatever the tab chose', () => {
    for (const partition of ['persist:app-3f9c', 'orivon-route-tab-3f9c0a']) {
      const { actions, sitePanel } = partsWith([{ id: 't1', url: 'https://news.example/a', isNewTab: false, isInternal: false, tunnelChoice: 'nym' }], 't1', partition)
      actions.openSiteInfo(anchor, 'tunnels', 'https://news.example/a')
      expect(sitePanel.toggleTab, partition).not.toHaveBeenCalled()
      expect(sitePanel.toggle, partition).toHaveBeenCalledExactlyOnceWith(anchor, 'https://news.example', 'tunnels', undefined)
    }
    const inProfile = partsWith([{ id: 't1', url: 'https://news.example/a', isNewTab: false, isInternal: false, tunnelChoice: 'nym' }], 't1', 'persist:tunnel-profile')
    inProfile.actions.openSiteInfo(anchor, 'tunnels', 'https://news.example/a')
    expect(inProfile.sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
  })

  it('opens the tab\'s list for the website a tab with no page yet is opening, which the chrome cannot name, as it does once the page has come', () => {
    const plain = partsWith([{ id: 't1', url: '', isNewTab: false, isInternal: false }], 't1', undefined, true, 'https://news.example/a')
    plain.actions.openSiteInfo(anchor, 'tunnels', '')
    expect(plain.sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
    expect(plain.sitePanel.toggle).not.toHaveBeenCalled()
    expect(plain.sitePanel.holdAgainstArrival, 'the list stays open when the page takes the keyboard as it commits').toHaveBeenCalledExactlyOnceWith({ id: 't1' })
    const withChoice = partsWith([{ id: 't1', url: '', isNewTab: false, isInternal: false, tunnelChoice: 'nym' }], 't1', 'persist:tunnel-profile', true, 'https://news.example/a')
    withChoice.actions.openSiteInfo(anchor, 'tunnels', '')
    expect(withChoice.sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
    expect(withChoice.sitePanel.toggle).not.toHaveBeenCalled()
    expect(withChoice.sitePanel.holdAgainstArrival).toHaveBeenCalledExactlyOnceWith({ id: 't1' })
  })

  it('decides from the website a redirect has led the tab to, which the record keeps as the target of the load, never the address it started at', () => {
    const { actions, sitePanel } = partsWith([{ id: 't1', url: '', isNewTab: false, isInternal: false }], 't1', undefined, true, 'https://news.example/landing')
    actions.openSiteInfo(anchor, 'tunnels', '')
    expect(sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
    // The address it started at can go through a tunnel; the page it was led to is on this computer, which the tab's choice does not reach.
    const local = partsWith([{ id: 't1', url: '', isNewTab: false, isInternal: false }], 't1', undefined, true, 'http://localhost:3000/')
    local.actions.openSiteInfo(anchor, 'tunnels', '')
    expect(local.sitePanel.toggleTab).not.toHaveBeenCalled()
    expect(local.sitePanel.toggle).toHaveBeenCalledTimes(1)
  })

  it('opens the tab\'s list for the page the tab has committed since the chrome last drew it, when the chrome still sent no address', () => {
    const { actions, sitePanel } = partsWith([{ id: 't1', url: 'https://news.example/a', isNewTab: false, isInternal: false }], 't1', undefined, true, undefined)
    actions.openSiteInfo(anchor, 'tunnels', '')
    expect(sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
    expect(sitePanel.holdAgainstArrival, 'the page has arrived, so there is nothing to hold against').not.toHaveBeenCalled()
  })

  it('opens no list of a website for a popup whose page has an opener until the website has answered, since the opener writes into what the popup shows', () => {
    const popup = partsWith([{ id: 't1', url: '', isNewTab: false, isInternal: false }], 't1', undefined, true, 'https://news.example/a', { url: 'https://evil.example/' })
    popup.actions.openSiteInfo(anchor, 'tunnels', '')
    expect(popup.sitePanel.toggle).not.toHaveBeenCalled()
    expect(popup.sitePanel.toggleTab).not.toHaveBeenCalled()
    const severed = partsWith([{ id: 't1', url: '', isNewTab: false, isInternal: false }], 't1', undefined, true, 'https://news.example/a', null)
    severed.actions.openSiteInfo(anchor, 'tunnels', '')
    expect(severed.sitePanel.toggleTab, 'a page opened with no opener is main\'s own').toHaveBeenCalledTimes(1)
  })

  it('opens the tab\'s list when a tab with a choice shows no page and opens none, and nothing for one with no choice', () => {
    const withChoice = partsWith([{ id: 't1', url: '', isNewTab: false, isInternal: false, tunnelChoice: 'direct' }], 't1')
    withChoice.actions.openSiteInfo(anchor, 'tunnels', '')
    expect(withChoice.sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
    const plain = partsWith([{ id: 't1', url: '', isNewTab: false, isInternal: false }], 't1')
    plain.actions.openSiteInfo(anchor, 'tunnels', '')
    expect(plain.sitePanel.toggleTab).not.toHaveBeenCalled()
    expect(plain.sitePanel.toggle).not.toHaveBeenCalled()
  })

  it('holds the list against no arrival when the page is already there', () => {
    const { actions, sitePanel } = partsWith([{ id: 't1', url: 'https://news.example/a', isNewTab: false, isInternal: false, tunnelChoice: 'nym' }], 't1')
    actions.openSiteInfo(anchor, 'tunnels', 'https://news.example/a')
    expect(sitePanel.toggleTab).toHaveBeenCalledTimes(1)
    expect(sitePanel.holdAgainstArrival).not.toHaveBeenCalled()
  })

  it('does not read the address a tab is opening for the shield or the key, which are about the page', () => {
    const { actions, sitePanel } = partsWith([{ id: 't1', url: '', isNewTab: false, isInternal: false }], 't1', undefined, true, 'https://news.example/a')
    actions.openSiteInfo(anchor, 'main', '')
    actions.openSiteInfo(anchor, 'web3', '')
    expect(sitePanel.toggle).not.toHaveBeenCalled()
    expect(sitePanel.toggleTab).not.toHaveBeenCalled()
  })

  it('opens it for a blank page that is no new tab as for a page with no origin: nothing, in a session of its own or the shared one', () => {
    for (const partition of ['persist:tunnel-profile', undefined]) {
      const { actions, sitePanel } = partsWith([{ id: 't1', url: 'about:blank', isNewTab: true, isInternal: false, blankPage: true }], 't1', partition)
      actions.openSiteInfo(anchor, 'tunnels')
      expect(sitePanel.toggleTab, String(partition)).not.toHaveBeenCalled()
      expect(sitePanel.toggle, String(partition)).not.toHaveBeenCalled()
    }
  })

  it('opens the list of a new tab whose keyboard is still moving only once it is placed, with the press it came from', () => {
    vi.useFakeTimers()
    vi.setSystemTime(80_000)
    try {
      const { actions, sitePanel, closeOverlays, place } = partsWith([{ id: 't1', isNewTab: true, isInternal: false }], 't1', undefined, false)
      actions.press('tunnels')
      actions.openSiteInfo(anchor, 'tunnels')
      expect(sitePanel.toggleTab).not.toHaveBeenCalled()
      expect(closeOverlays).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      place()
      expect(sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', 80_000)
      expect(closeOverlays).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes a second press of the button while it waits as the same press: its list opens once, when the keyboard is placed, with the first press\'s stamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(80_000)
    try {
      const { actions, sitePanel, place } = partsWith([{ id: 't1', isNewTab: true, isInternal: false }], 't1', undefined, false)
      actions.press('tunnels')
      actions.openSiteInfo(anchor, 'tunnels')
      vi.advanceTimersByTime(200)
      actions.press('tunnels')
      actions.openSiteInfo(anchor, 'tunnels')
      expect(sitePanel.toggleTab).not.toHaveBeenCalled()
      place()
      expect(sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', 80_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens nothing when the tab it waited for is no longer the one the button is about, and the next press is not read as a repeat of it', () => {
    const { actions, sitePanel, place, state } = partsWith([{ id: 't1', isNewTab: true, isInternal: false }, { id: 't2', url: 'https://news.example/', isNewTab: false, isInternal: false }], 't1', undefined, false)
    actions.openSiteInfo(anchor, 'tunnels')
    state.activeTabId = 't2'
    place()
    expect(sitePanel.toggleTab).not.toHaveBeenCalled()
    state.activeTabId = 't1'
    actions.openSiteInfo(anchor, 'tunnels')
    place()
    expect(sitePanel.toggleTab).toHaveBeenCalledExactlyOnceWith(anchor, 't1', undefined)
  })

  it('never opens the tab\'s popover for the shield or the key, which are about the page', () => {
    const { actions, sitePanel } = partsWith([{ id: 't1', isNewTab: true, isInternal: false }], 't1')
    actions.openSiteInfo(anchor, 'main')
    actions.openSiteInfo(anchor, 'web3')
    expect(sitePanel.toggleTab).not.toHaveBeenCalled()
    expect(sitePanel.toggle).not.toHaveBeenCalled()
  })
})
