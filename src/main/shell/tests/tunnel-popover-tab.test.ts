import { describe, expect, it } from 'vitest'
import { tabForTunnelPopover } from '../tunnel-popover-tab.js'
import type { TabsSnapshot, TabState } from '../tab-types.js'

const tab = (over: Partial<TabState> = {}): TabState => ({ id: 't1', url: 'https://news.example/', isNewTab: false, isInternal: false, ...over } as TabState)
const snapshot = (...tabs: TabState[]): TabsSnapshot => ({ tabs, activeTabId: tabs[0]?.id ?? null })
const notApp = (): boolean => false
const shared = (): undefined => undefined
const inPartition = (partition: string) => (): string => partition

describe('which tab the tunnel button\'s popover is about', () => {
  it('is the tab in front when it is a new tab, whatever the chrome says it shows', () => {
    expect(tabForTunnelPopover(snapshot(tab({ isNewTab: true, url: '' })), shared, notApp)).toBe('t1')
    expect(tabForTunnelPopover(snapshot(tab({ isNewTab: true, url: 'about:blank' })), shared, notApp)).toBe('t1')
  })

  it('is the tab in front when it carries a tunnel choice and shows a website', () => {
    for (const tunnelChoice of ['nym', 'socks5', 'direct'] as const) expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice })), shared, notApp), tunnelChoice).toBe('t1')
    expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice: 'nym', url: 'http://localhost:3000/' })), shared, notApp), 'this computer, which the choice does not send through a tunnel, is still the tab\'s').toBe('t1')
  })

  it('is the tab in front for a website in the session of any tunnel profile, which is where its choice put it', () => {
    for (const partition of ['persist:tunnel-profile', 'persist:proxy-profile', 'persist:direct-profile', 'tunnel-profile-memory']) {
      expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice: 'nym' })), inPartition(partition), notApp), partition).toBe('t1')
    }
  })

  it('is no tab for a website in a tab with no choice, which has a tunnel of its own', () => {
    expect(tabForTunnelPopover(snapshot(tab()), shared, notApp)).toBeUndefined()
  })

  it('is no tab for an installed app, which keeps its own route whatever the tab carries', () => {
    expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice: 'nym', url: 'https://app.example/' })), shared, (origin) => origin === 'https://app.example')).toBeUndefined()
  })

  it('is no tab for a page in a session an app or a temporary route made for it, which keeps that session\'s tunnel whatever the tab carries', () => {
    for (const partition of ['persist:app-3f9c', 'orivon-route-tab-3f9c0a', 'persist:orivon-local-files']) {
      expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice: 'nym' })), inPartition(partition), notApp), partition).toBeUndefined()
    }
  })

  it('is no tab for a blank page in a session of its own, which is no new tab', () => {
    expect(tabForTunnelPopover(snapshot(tab({ isNewTab: true, url: 'about:blank', blankInSession: true, tunnelChoice: 'nym' })), inPartition('persist:tunnel-profile'), notApp)).toBeUndefined()
  })

  it('reads the page from the tab\'s record, not from anything the chrome sent', () => {
    // A website that navigated to an installed app is the app's page, whatever address the chrome last drew.
    expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice: 'nym', url: 'https://app.example/' })), shared, (origin) => origin === 'https://app.example')).toBeUndefined()
    expect(tabForTunnelPopover(snapshot(tab({ tunnelChoice: 'nym', url: 'https://news.example/' })), shared, (origin) => origin === 'https://app.example')).toBe('t1')
  })

  it('is no tab for a page of the shell, which has no tunnel button, nor with no tab in front', () => {
    expect(tabForTunnelPopover(snapshot(tab({ isInternal: true, tunnelChoice: 'nym' })), shared, notApp)).toBeUndefined()
    expect(tabForTunnelPopover({ tabs: [], activeTabId: null }, shared, notApp)).toBeUndefined()
  })
})
