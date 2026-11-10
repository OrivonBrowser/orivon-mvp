// The tab a first visit sends into the app, named to the pages that load again when the app starts to be served: the visit
// loads that one itself. Electron-free beyond the types: the tab reference comes from the visit's host.
import { enteringPage } from '../sessions/stale-pages.js'
import type { TabRef } from './tab-screens.js'

/** Marks the page of `tab` (the host's opaque reference) as being sent into the app; returns the end of that. A tab with no live page needs no mark. */
export function enteringTab (tab: object | undefined): () => void {
  const ref = tab as TabRef | undefined
  const page = ref?.window.tabs.liveWebContents(ref.tabId)
  return page === undefined ? () => {} : enteringPage(page)
}
