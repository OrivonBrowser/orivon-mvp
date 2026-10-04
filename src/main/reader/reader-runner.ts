// Opens and closes the reader tab: the article is taken from the tab in front, kept for the window, and
// shown in the shell's reader page, a tab beside the article's. One reader tab per window, reused for
// the next article. Reader view is a command only: no website can reach it.
import type { WebContents } from 'electron'
import type { TabManager } from '../shell/tabs.js'
import type { Article } from './reader-blocks.js'
import { imageSlots, linkTable } from './reader-blocks.js'
import { fetchArticleImages } from './reader-images.js'
import type { ImageFetcher } from './reader-images.js'
import type { ReaderArticles } from './reader-store.js'

export type ReaderTabs = Pick<TabManager, 'activateTab' | 'closeTab' | 'getState' | 'ids' | 'liveWebContents' | 'moveTab' | 'openInternal' | 'record'>

export interface ReaderDeps {
  readonly articles: ReaderArticles
  readonly extract: (wc: WebContents) => Promise<Article | null>
  /** The fetch of the session the source tab runs in. */
  readonly fetcher: (wc: WebContents) => ImageFetcher
  /** Tells the reader pages the article changed, or that a picture arrived. */
  readonly publish: (topic: string, payload: unknown) => void
  readonly notify: (code: 'notReadable') => void
}

const WEB_URL = /^https?:\/\//i

/** The id of the window's reader tab, if it has one. */
export function readerTabId (tabs: Pick<ReaderTabs, 'ids' | 'record'>): string | undefined {
  return tabs.ids().find((id) => tabs.record(id)?.internalPage === 'reader')
}

/** Puts `tabId` right of `sourceId` (and of the tab joined to it): an unpinned tab, so a pinned source puts it where the pinned run ends. */
export function placeBeside (tabs: Pick<ReaderTabs, 'getState' | 'ids' | 'moveTab'>, tabId: string, sourceId: string): void {
  const order = tabs.ids()
  const source = order.indexOf(sourceId)
  if (source === -1) return
  const partner = tabs.getState().tabs.find((tab) => tab.id === sourceId)?.splitWith ?? null
  const end = Math.max(source, partner === null ? -1 : order.indexOf(partner))
  tabs.moveTab(tabId, order.indexOf(tabId) > end ? end + 1 : end)
}

/** Closes the reader tab and shows the article's tab again, when it is still open. */
export function closeReader (tabs: ReaderTabs, readerId: string): void {
  const source = tabs.record(readerId)?.reader?.source
  if (source !== undefined && tabs.ids().includes(source)) tabs.activateTab(source)
  tabs.closeTab(readerId)
}

export async function toggleReader (tabs: ReaderTabs, deps: ReaderDeps): Promise<void> {
  const state = tabs.getState()
  const activeId = state.activeTabId
  const tab = state.tabs.find((candidate) => candidate.id === activeId)
  if (activeId === null || tab === undefined) return
  if (tabs.record(activeId)?.internalPage === 'reader') {
    closeReader(tabs, activeId)
    return
  }
  const wc = tabs.liveWebContents(activeId)
  if (wc === undefined || tab.isNewTab || tab.isInternal || !WEB_URL.test(tab.url)) {
    deps.notify('notReadable')
    return
  }
  const article = await deps.extract(wc)
  // The extraction took a moment: if the person went to another tab or the page was swapped, the answer is dropped, not shown over what they are doing.
  if (tabs.getState().activeTabId !== activeId || tabs.liveWebContents(activeId) !== wc) return
  if (article === null) {
    deps.notify('notReadable')
    return
  }
  const existing = readerTabId(tabs)
  tabs.openInternal('reader')
  const readerId = readerTabId(tabs)
  if (readerId === undefined) return
  const record = tabs.record(readerId)
  if (record === undefined) return
  // Kept under the reader tab's record, which goes with the tab if it is moved to another window.
  const entry = deps.articles.set(record, article, linkTable(article), activeId)
  // Beside an article that is in a group, the reader tab is in that group too, as a tab opened to its right is.
  record.reader = { source: activeId, address: tab.url }
  record.groupId = tabs.record(activeId)?.groupId ?? null
  placeBeside(tabs, readerId, activeId)
  if (existing !== undefined) deps.publish('reader.changed', undefined)
  const alive = (): boolean => deps.articles.get(record)?.token === entry.token && tabs.ids().includes(readerId)
  const fetcher = deps.fetcher(wc)
  void fetchArticleImages(imageSlots(article), fetcher, article.url, (at, dataUrl) => {
    entry.images.set(at, dataUrl)
    deps.publish('reader.image', { token: entry.token, at, src: dataUrl })
  }, alive)
}
