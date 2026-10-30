import { beforeEach, describe, expect, it, vi } from 'vitest'
import { navigateFromBrowser, openFromActiveTab, openFromBrowser, openNowFromBrowser } from '../open-from-browser.js'
import type { BrowserTabs } from '../open-from-browser.js'

const FILE = 'file:///home/u/notes/app.html'

function fakeTabs (newTab = false, canGoForward = false): { tabs: BrowserTabs, calls: string[] } {
  const calls: string[] = []
  const tabs: BrowserTabs = {
    createTab: vi.fn((url?: string, active = true) => { calls.push(`create ${url ?? ''} ${active}`); return 'web' }),
    openLocalFile: vi.fn((url: string, active = true) => { calls.push(`file ${url} ${active}`); return Promise.resolve('local') }),
    openLocalFileNow: vi.fn((url: string, active = true) => { calls.push(`now ${url} ${active}`); return 'known' }),
    navigate: vi.fn((id: string, input: string) => { calls.push(`navigate ${id} ${input}`) }),
    closeTab: vi.fn((id: string) => { calls.push(`close ${id}`) }),
    getState: () => ({ tabs: [{ id: 't1', isNewTab: newTab, canGoBack: false, canGoForward }], activeTabId: 't1' }) as never,
    activeWebContents: () => undefined
  }
  return { tabs, calls }
}

beforeEach(() => { vi.clearAllMocks() })

describe('navigateFromBrowser on a new tab that Back reached', () => {
  it('leaves the tab open, because it still holds the page ahead of it', async () => {
    const { tabs, calls } = fakeTabs(true, true)
    await navigateFromBrowser(tabs, 't1', FILE)
    expect(calls).toEqual([`file ${FILE} true`])
  })
})

describe('openFromBrowser', () => {
  it('opens a web address as an ordinary tab and a local file through openLocalFile', () => {
    const { tabs, calls } = fakeTabs()
    openFromBrowser(tabs, 'https://example.com/')
    openFromBrowser(tabs, FILE, false)
    expect(calls).toEqual(['create https://example.com/ true', `file ${FILE} false`])
  })

  it('hands the tab the tunnel choice it is given, and leaves a local file without one', () => {
    const { tabs } = fakeTabs()
    openFromBrowser(tabs, 'https://example.com/', false, 'nym')
    expect(tabs.createTab).toHaveBeenLastCalledWith('https://example.com/', false, undefined, 'nym')
    openFromBrowser(tabs, FILE, true, 'nym')
    expect(tabs.openLocalFile).toHaveBeenLastCalledWith(FILE, true)
    openFromBrowser(tabs, 'https://example.com/')
    expect(tabs.createTab).toHaveBeenLastCalledWith('https://example.com/', true)
  })

  it('never hands a file address with a host to a tab', () => {
    const { tabs, calls } = fakeTabs()
    openFromBrowser(tabs, 'file://server/share/a.html')
    expect(calls).toEqual(['create file://server/share/a.html true'])
  })
})

describe('openFromActiveTab', () => {
  it('opens the address in a tab that keeps the tunnel choice of the tab in front, so its first request leaves by that tunnel', () => {
    for (const choice of ['nym', 'socks5', 'direct'] as const) {
      const createTab = vi.fn(() => 'new')
      expect(openFromActiveTab({ createTab, activeTunnelChoice: () => choice }, 'https://home.example/')).toBe('new')
      expect(createTab).toHaveBeenCalledWith('https://home.example/', true, undefined, choice)
    }
  })

  it('opens it with no choice when the tab in front has none', () => {
    const createTab = vi.fn(() => 'new')
    openFromActiveTab({ createTab, activeTunnelChoice: () => undefined }, 'https://home.example/')
    expect(createTab).toHaveBeenCalledWith('https://home.example/', true, undefined, undefined)
  })
})

describe('openNowFromBrowser', () => {
  it('answers the id of a web tab or of a file the fuse answer is already in for', () => {
    const { tabs } = fakeTabs()
    expect(openNowFromBrowser(tabs, 'https://example.com/', true)).toBe('web')
    expect(openNowFromBrowser(tabs, FILE, true)).toBe('known')
  })

  it('falls back to the waiting open when the fuse answer is not in yet', () => {
    const { tabs, calls } = fakeTabs()
    vi.mocked(tabs.openLocalFileNow).mockReturnValue(undefined)
    expect(openNowFromBrowser(tabs, FILE, false)).toBeUndefined()
    expect(calls).toContain(`file ${FILE} false`)
  })
})

describe('navigateFromBrowser', () => {
  it('leaves a web address to the tab\'s own navigation', async () => {
    const { tabs, calls } = fakeTabs()
    await navigateFromBrowser(tabs, 't1', 'example.com')
    expect(calls).toEqual(['navigate t1 example.com'])
  })

  it('opens a typed path in a new tab and leaves a page the tab shows alone', async () => {
    const { tabs, calls } = fakeTabs(false)
    await navigateFromBrowser(tabs, 't1', '/home/u/notes/app.html')
    expect(calls).toEqual([`file ${FILE} true`])
  })

  it('closes the empty new-tab page it was typed on once the file has opened', async () => {
    const { tabs, calls } = fakeTabs(true)
    await navigateFromBrowser(tabs, 't1', FILE)
    expect(calls).toEqual([`file ${FILE} true`, 'close t1'])
  })

  it('keeps the new-tab page when the file did not open', async () => {
    const { tabs, calls } = fakeTabs(true)
    vi.mocked(tabs.openLocalFile).mockResolvedValue(undefined)
    await navigateFromBrowser(tabs, 't1', FILE)
    expect(calls).toEqual([])
  })
})
