import { describe, expect, it, vi } from 'vitest'

// UPSTREAM.md patch 70: chrome.runtime.getContexts reports the extension's side panel pages, with their window.
vi.mock('electron', () => ({ BaseWindow: { getAllWindows: () => [] }, BrowserWindow: { getAllWindows: () => [] }, nativeImage: {} }))

const { RuntimeAPI } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/runtime.js')

const ID = 'c'.repeat(32)

function setup (panels: Array<{ contextType: 'SIDE_PANEL', contents: { id: number, getURL: () => string }, windowId: number }> | undefined) {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const ctx = {
    router: { apiHandler: () => (name: string, fn: (...args: any[]) => unknown) => { handlers.set(name, fn) } },
    session: { serviceWorkers: { getAllRunning: () => ({}) } },
    store: { impl: panels === undefined ? {} : { extensionContexts: (id: string) => (id === ID ? panels : []) }, tabs: new Set() }
  }
  new RuntimeAPI(ctx as never, { getDocumentWebContents: () => undefined } as never, { getOpenPopup: () => undefined } as never)
  const event = { type: 'frame', sender: {}, extension: { id: ID, manifest: {} } }
  return async (filter?: unknown): Promise<any[]> => await handlers.get('runtime.getContexts')?.(event, filter) as any[]
}

const PANEL = { contextType: 'SIDE_PANEL' as const, contents: { id: 9, getURL: () => `chrome-extension://${ID}/panel.html` }, windowId: 4 }

describe('chrome.runtime.getContexts and the side panel', () => {
  it('lists a side panel page with its window and address', async () => {
    const contexts = await setup([PANEL])()
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({
      contextId: 'sidepanel:9', contextType: 'SIDE_PANEL',
      documentUrl: `chrome-extension://${ID}/panel.html`, frameId: 0, incognito: false, tabId: -1, windowId: 4
    })
  })

  it('filters by context type and by window like any other context', async () => {
    const get = setup([PANEL])
    expect(await get({ contextTypes: ['TAB'] })).toEqual([])
    expect(await get({ contextTypes: ['SIDE_PANEL'], windowIds: [4] })).toHaveLength(1)
    expect(await get({ windowIds: [5] })).toEqual([])
  })

  it('lists none when the host reports none or cannot', async () => {
    expect(await setup([])()).toEqual([])
    expect(await setup(undefined)()).toEqual([])
  })
})
