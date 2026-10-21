import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { Bookmark, BookmarkStore } from '../../browsing/bookmarks.js'
import { FeaturedStore } from '../../newtab/featured-store.js'
import type { WindowRegistry } from '../../shell/window-registry.js'

// isFromDashboard's sender check, mirroring how ipc.ts's own isFromChrome is
// exercised (dispatch through the registered handler, not by exporting the
// check itself): every other sender check in this codebase also requires
// the sender frame to be the webContents' own top frame, not only that its
// URL matches -- this proves that requirement holds here too.
const handlers = new Map<string, (event: unknown, command: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, command: unknown) => unknown) => { handlers.set(channel, fn) } }
}))

const { registerNewTabIpc } = await import('../newtab-ipc.js')
const { NEWTAB_COMMAND_CHANNEL } = await import('../../channels.js')

const DASHBOARD_URL = 'http://localhost:5999/newtab/'
const BOOKMARK: Bookmark = { url: 'https://a.example/', title: 'A', favicon: null }

const featured = new FeaturedStore(null)

function dispatch (frameUrl: string, isTopFrame: boolean, command: unknown = { type: 'getBookmarks' }): unknown {
  const handler = handlers.get(NEWTAB_COMMAND_CHANNEL)
  if (handler === undefined) throw new Error('registerNewTabIpc did not register a handler')
  const senderFrame = { url: frameUrl }
  const sender = { mainFrame: isTopFrame ? senderFrame : {} } as unknown as WebContents
  const event = { senderFrame, sender } as unknown as IpcMainInvokeEvent
  return handler(event, command)
}

describe('registerNewTabIpc -- isFromDashboard', () => {
  const load = vi.fn(async () => {})
  const bookmarks = { getAll: vi.fn(() => [BOOKMARK]), load } as unknown as BookmarkStore
  const windows = {} as WindowRegistry
  registerNewTabIpc(DASHBOARD_URL, windows, bookmarks, featured)

  it('answers the dashboard\'s own top frame, once the bookmark file has been read', async () => {
    expect(await dispatch(DASHBOARD_URL, true)).toEqual([BOOKMARK])
    expect(load).toHaveBeenCalled()
  })

  it('leaves a bookmarked local file off the tiles, which can only navigate a web address', async () => {
    const file: Bookmark = { url: 'file:///home/a/x.html', title: 'X', favicon: null }
    bookmarks.getAll = vi.fn(() => [file, BOOKMARK])
    expect(await dispatch(DASHBOARD_URL, true)).toEqual([BOOKMARK])
  })

  it('refuses a subframe at the dashboard\'s own address', async () => {
    expect(await dispatch(DASHBOARD_URL, false)).toBeUndefined()
  })

  it('refuses the top frame once it has navigated away', async () => {
    expect(await dispatch('https://elsewhere.example/', true)).toBeUndefined()
  })
})

describe('registerNewTabIpc -- the Featured row\'s choices', () => {
  const hidden = { type: 'getFeatured' }

  it('answers the pin and the hidden tiles, and changes them only for the dashboard', async () => {
    featured.setNewcomerPin('asgardex')
    expect(await dispatch(DASHBOARD_URL, true, hidden)).toEqual({ newcomerPin: 'asgardex', newcomerName: null, unpinned: [], hidden: [] })
    expect(await dispatch(DASHBOARD_URL, true, { type: 'hideFeatured', id: 'explore' })).toMatchObject({ hidden: ['explore'] })
    expect(await dispatch('https://elsewhere.example/', true, { type: 'hideFeatured', id: 'thelounge' })).toBeUndefined()
    expect(await dispatch(DASHBOARD_URL, false, hidden)).toBeUndefined()
    expect(featured.get().hidden).toEqual(['explore'])
  })

  it('removes the pin for good when the person unpins it, and brings hidden tiles back', async () => {
    expect(await dispatch(DASHBOARD_URL, true, { type: 'unpinFeatured', id: 'asgardex' })).toMatchObject({ newcomerPin: null, unpinned: ['asgardex'] })
    expect(featured.setNewcomerPin('asgardex')).toBe(false)
    expect(await dispatch(DASHBOARD_URL, true, { type: 'showHiddenFeatured' })).toMatchObject({ hidden: [], newcomerPin: null })
  })

  it('ignores an id that is no string', async () => {
    expect(await dispatch(DASHBOARD_URL, true, { type: 'hideFeatured', id: 4 })).toMatchObject({ hidden: [] })
  })
})
