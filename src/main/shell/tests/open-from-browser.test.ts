import { beforeEach, describe, expect, it, vi } from 'vitest'
import { navigateFromBrowser, openFromBrowser, openNowFromBrowser } from '../open-from-browser.js'
import type { BrowserTabs } from '../open-from-browser.js'

const FILE = 'file:///home/u/notes/app.html'

function fakeTabs (newTab = false): { tabs: BrowserTabs, calls: string[] } {
  const calls: string[] = []
  const tabs: BrowserTabs = {
    createTab: vi.fn((url?: string, active = true) => { calls.push(`create ${url ?? ''} ${active}`); return 'web' }),
    openLocalFile: vi.fn((url: string, active = true) => { calls.push(`file ${url} ${active}`); return Promise.resolve('local') }),
    openLocalFileNow: vi.fn((url: string, active = true) => { calls.push(`now ${url} ${active}`); return 'known' }),
    navigate: vi.fn((id: string, input: string) => { calls.push(`navigate ${id} ${input}`) }),
    closeTab: vi.fn((id: string) => { calls.push(`close ${id}`) }),
    getState: () => ({ tabs: [{ id: 't1', isNewTab: newTab }], activeTabId: 't1' }) as never,
    activeWebContents: () => undefined
  }
  return { tabs, calls }
}

beforeEach(() => { vi.clearAllMocks() })

describe('openFromBrowser', () => {
  it('opens a web address as an ordinary tab and a local file through openLocalFile', () => {
    const { tabs, calls } = fakeTabs()
    openFromBrowser(tabs, 'https://example.com/')
    openFromBrowser(tabs, FILE, false)
    expect(calls).toEqual(['create https://example.com/ true', `file ${FILE} false`])
  })

  it('never hands a file address with a host to a tab', () => {
    const { tabs, calls } = fakeTabs()
    openFromBrowser(tabs, 'file://server/share/a.html')
    expect(calls).toEqual(['create file://server/share/a.html true'])
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
