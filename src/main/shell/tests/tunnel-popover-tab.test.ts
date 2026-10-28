import { describe, expect, it } from 'vitest'
import { tabForTunnelPopover } from '../tunnel-popover-tab.js'
import type { TabsSnapshot, TabState } from '../tab-types.js'

const tab = (over: Partial<TabState> = {}): TabState => ({ id: 't1', url: 'https://news.example/', isNewTab: false, isInternal: false, ...over } as TabState)
const snapshot = (...tabs: TabState[]): TabsSnapshot => ({ tabs, activeTabId: tabs[0]?.id ?? null })
const notApp = (): boolean => false

describe('which tab the tunnel button\'s popover is about', () => {
  it('is the tab in front when it is a new tab, whatever the chrome says it shows', () => {
    expect(tabForTunnelPopover(snapshot(tab({ isNewTab: true, url: '' })), undefined, notApp)).toBe('t1')
    expect(tabForTunnelPopover(snapshot(tab({ isNewTab: true })), 'https://elsewhere.example/', notApp)).toBe('t1')
  })

  it('is the tab in front when it carries a tunnel choice and shows a website', () => {
    for (const tunnelChoice of ['nym', 'socks5', 'direct'] as const) expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice })), 'https://news.example/', notApp), tunnelChoice).toBe('t1')
    expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice: 'nym' })), 'http://localhost:3000/', notApp), 'this computer, which the choice does not send through a tunnel, is still the tab\'s').toBe('t1')
  })

  it('is no tab for a website in a tab with no choice, which has a tunnel of its own', () => {
    expect(tabForTunnelPopover(snapshot(tab()), 'https://news.example/', notApp)).toBeUndefined()
  })

  it('is no tab for an installed app, which keeps its own route whatever the tab carries', () => {
    expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice: 'nym', url: 'https://app.example/' })), 'https://app.example/', (origin) => origin === 'https://app.example')).toBeUndefined()
  })

  it('is no tab for a page of the shell, which has no tunnel button, nor when the chrome names no page, nor with no tab in front', () => {
    expect(tabForTunnelPopover(snapshot(tab({ isInternal: true, tunnelChoice: 'nym' })), 'orivon://settings/', notApp)).toBeUndefined()
    expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice: 'nym' })), undefined, notApp)).toBeUndefined()
    expect(tabForTunnelPopover({ tabs: [], activeTabId: null }, undefined, notApp)).toBeUndefined()
  })
})
