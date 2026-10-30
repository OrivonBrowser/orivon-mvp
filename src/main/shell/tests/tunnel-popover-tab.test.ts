import { describe, expect, it } from 'vitest'
import { addressOfFrontTab, openingAddressOf, tabForTunnelPopover } from '../tunnel-popover-tab.js'
import type { OpeningAddress } from '../tunnel-popover-tab.js'
import type { TabsSnapshot, TabState } from '../tab-types.js'

const tab = (over: Partial<TabState> = {}): TabState => ({ id: 't1', url: 'https://news.example/', isNewTab: false, isInternal: false, ...over } as TabState)
const snapshot = (...tabs: TabState[]): TabsSnapshot => ({ tabs, activeTabId: tabs[0]?.id ?? null })
const notApp = (): boolean => false
const shared = (): undefined => undefined
const inPartition = (partition: string) => (): string => partition
/** The popover's tab for a tab that is opening nothing, unless the test says what it is opening. */
const forTab = (state: TabsSnapshot, partitionOf: (id: string) => string | undefined, isApp: (origin: string) => boolean, opening: OpeningAddress = () => undefined): string | undefined => tabForTunnelPopover(state, partitionOf, isApp, opening)

describe('which tab the tunnel button\'s popover is about', () => {
  it('is the tab in front when it is a new tab, whatever the chrome says it shows', () => {
    expect(forTab(snapshot(tab({ isNewTab: true, url: '' })), shared, notApp)).toBe('t1')
    expect(forTab(snapshot(tab({ isNewTab: true, url: 'about:blank' })), shared, notApp)).toBe('t1')
  })

  it('is the tab in front for a website, whether or not the tab carries a tunnel choice and the website has an entry of its own', () => {
    for (const tunnelChoice of ['nym', 'socks5', 'direct'] as const) expect(forTab(snapshot(tab({ tunnelChoice })), shared, notApp), tunnelChoice).toBe('t1')
    expect(forTab(snapshot(tab()), shared, notApp), 'no choice').toBe('t1')
    expect(forTab(snapshot(tab({ url: 'http://news.example/' })), shared, notApp), 'a plain http website').toBe('t1')
  })

  it('is no tab for a page that cannot go through a tunnel (this computer, a file, anything that is no web origin), whatever the tab carries', () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1:8080/', 'file:///home/me/page.html', 'data:text/html,hello']) {
      for (const tunnelChoice of [undefined, 'nym', 'direct'] as const) expect(forTab(snapshot(tab(tunnelChoice === undefined ? { url } : { url, tunnelChoice })), shared, notApp), `${url} ${String(tunnelChoice)}`).toBeUndefined()
    }
  })

  it('is the tab in front for a website in the session of any tunnel profile, which is where its choice put it', () => {
    for (const partition of ['persist:tunnel-profile', 'persist:proxy-profile', 'persist:direct-profile', 'tunnel-profile-memory']) {
      expect(forTab(snapshot(tab({ tunnelChoice: 'nym' })), inPartition(partition), notApp), partition).toBe('t1')
    }
  })

  it('is no tab for an installed app, which keeps its own route whatever the tab carries', () => {
    expect(forTab(snapshot(tab({ tunnelChoice: 'nym', url: 'https://app.example/' })), shared, (origin) => origin === 'https://app.example')).toBeUndefined()
  })

  it('is no tab for a page in a session an app or a temporary route made for it, which keeps that session\'s tunnel whatever the tab carries', () => {
    for (const partition of ['persist:app-3f9c', 'orivon-route-tab-3f9c0a', 'persist:orivon-local-files']) {
      expect(forTab(snapshot(tab({ tunnelChoice: 'nym' })), inPartition(partition), notApp), partition).toBeUndefined()
    }
  })

  it('is no tab for a blank page that is no dashboard, whatever its session, which is no new tab', () => {
    for (const session of [inPartition('persist:tunnel-profile'), shared]) {
      expect(forTab(snapshot(tab({ isNewTab: true, url: 'about:blank', blankPage: true, tunnelChoice: 'nym' })), session, notApp)).toBeUndefined()
    }
  })

  it('is no tab for a popup that has committed nothing yet, which has no tunnel button, whatever choice the tab carries', () => {
    for (const session of [inPartition('persist:tunnel-profile'), shared]) {
      expect(forTab(snapshot(tab({ url: '', blankPage: true, tunnelChoice: 'nym' })), session, notApp)).toBeUndefined()
    }
  })

  it('reads the page from the tab\'s record, not from anything the chrome sent', () => {
    // A website that navigated to an installed app is the app's page, whatever address the chrome last drew.
    expect(forTab(snapshot(tab({ tunnelChoice: 'nym', url: 'https://app.example/' })), shared, (origin) => origin === 'https://app.example')).toBeUndefined()
    expect(forTab(snapshot(tab({ tunnelChoice: 'nym', url: 'https://news.example/' })), shared, (origin) => origin === 'https://app.example')).toBe('t1')
  })

  it('is no tab for a page of the shell, which has no tunnel button, nor with no tab in front', () => {
    expect(forTab(snapshot(tab({ isInternal: true, tunnelChoice: 'nym' })), shared, notApp)).toBeUndefined()
    expect(forTab({ tabs: [], activeTabId: null }, shared, notApp)).toBeUndefined()
  })
})

describe('a tab whose first page has not committed (its address is empty)', () => {
  const uncommitted = (over: Partial<TabState> = {}): TabState => tab({ url: '', ...over })
  const opening = (address: string | undefined) => (): string | undefined => address

  it('is the tab when it is opening a website and carries no choice, as it is once the page has come', () => {
    expect(tabForTunnelPopover(snapshot(uncommitted()), shared, notApp, opening('https://news.example/a'))).toBe('t1')
  })

  it('is no tab when what it is opening cannot go through a tunnel', () => {
    for (const address of ['http://localhost:3000/', 'file:///home/me/page.html']) expect(tabForTunnelPopover(snapshot(uncommitted({ tunnelChoice: 'nym' })), shared, notApp, opening(address)), address).toBeUndefined()
  })

  it('is the tab when it carries a choice and is opening a website, which the choice decides', () => {
    for (const tunnelChoice of ['nym', 'socks5', 'direct'] as const) expect(tabForTunnelPopover(snapshot(uncommitted({ tunnelChoice })), shared, notApp, opening('https://news.example/a')), tunnelChoice).toBe('t1')
  })

  it('is no tab for an installed app it is opening, whatever the tab carries, as for the app\'s page', () => {
    const isApp = (origin: string): boolean => origin === 'https://app.example'
    expect(tabForTunnelPopover(snapshot(uncommitted({ tunnelChoice: 'nym' })), shared, isApp, opening('https://app.example/'))).toBeUndefined()
  })

  it('is the tab when it carries a choice and opens nothing yet, as it was before the page had an address; with no choice it is no tab, the one blank page the button has no list for', () => {
    for (const tunnelChoice of ['nym', 'socks5', 'direct'] as const) expect(tabForTunnelPopover(snapshot(uncommitted({ tunnelChoice })), shared, notApp, opening(undefined)), tunnelChoice).toBe('t1')
    expect(tabForTunnelPopover(snapshot(uncommitted()), shared, notApp, opening(undefined))).toBeUndefined()
  })

  it('is no tab in a session of an app or a temporary route, which keeps its own tunnel, whatever it is opening', () => {
    for (const partition of ['persist:app-3f9c', 'orivon-route-tab-3f9c0a']) {
      expect(tabForTunnelPopover(snapshot(uncommitted({ tunnelChoice: 'nym' })), inPartition(partition), notApp, opening('https://news.example/a')), partition).toBeUndefined()
    }
  })

  it('asks for the address only of a tab with no page, never of one that shows a page', () => {
    const pending = (): string => 'https://other.example/'
    const pendingIsApp = (origin: string): boolean => origin === 'https://other.example'
    expect(tabForTunnelPopover(snapshot(tab({ url: 'https://news.example/' })), shared, pendingIsApp, pending)).toBe('t1')
    expect(tabForTunnelPopover(snapshot(tab({ url: 'https://news.example/', tunnelChoice: 'nym' })), shared, pendingIsApp, pending)).toBe('t1')
  })
})

describe('the address a tab in front is opening', () => {
  it('is the address in flight for a tab that has no page yet', () => {
    expect(addressOfFrontTab(snapshot(tab({ url: '' })), () => 'https://news.example/a')).toBe('https://news.example/a')
  })

  it('is the page\'s own once it has committed, which the chrome may not have drawn yet, and never the address in flight', () => {
    expect(addressOfFrontTab(snapshot(tab({ url: 'https://news.example/' })), () => 'https://other.example/')).toBe('https://news.example/')
  })

  it('is nothing when nothing is in flight, nor with no tab in front', () => {
    expect(addressOfFrontTab(snapshot(tab({ url: '' })), () => undefined)).toBeUndefined()
    expect(addressOfFrontTab({ tabs: [], activeTabId: null }, () => 'https://news.example/')).toBeUndefined()
  })
})

describe('where a tab\'s first navigation leads', () => {
  const view = { webContents: {} }
  type Opening = { inflightTarget?: string, view?: object, popupWithOpener?: object }
  const tabs = (record: Opening | undefined, contents: { opener?: unknown } | undefined) => openingAddressOf({ record: () => record as never, liveWebContents: () => contents })

  it('is the address the navigation has been redirected to, which the record keeps beside the one it started at', () => {
    expect(tabs({ inflightTarget: 'https://news.example/a' }, { opener: null })('t1')).toBe('https://news.example/a')
    expect(tabs({ inflightTarget: 'https://news.example/a' }, {})('t1'), 'a page that reports no opener has none').toBe('https://news.example/a')
  })

  it('is nothing for a tab whose page has an opener, which writes into the empty document the tab shows until the website answers', () => {
    expect(tabs({ inflightTarget: 'https://news.example/a' }, { opener: { url: 'https://other.example/' } })('t1')).toBeUndefined()
  })

  it('is nothing for a tab that started as a popup, however the opener reads later: the page that opened it can cut the link and still write into the document', () => {
    expect(tabs({ inflightTarget: 'https://news.example/a', view, popupWithOpener: view }, { opener: null })('t1')).toBeUndefined()
  })

  it('is the address once the tab shows another view than the popup it started as, which the browser itself is loading', () => {
    expect(tabs({ inflightTarget: 'https://news.example/a', view: { webContents: {} }, popupWithOpener: view }, { opener: null })('t1')).toBe('https://news.example/a')
  })

  it('is nothing with nothing in flight, no record or no live page', () => {
    expect(tabs({}, { opener: null })('t1')).toBeUndefined()
    expect(tabs(undefined, { opener: null })('t1')).toBeUndefined()
    expect(tabs({ inflightTarget: 'https://news.example/a' }, undefined)('t1')).toBeUndefined()
  })
})
