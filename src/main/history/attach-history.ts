// Writes down the pages a tab reaches. A visit is a top-level navigation that
// committed, of a page a person could go back to: not the new-tab page, not one
// of the shell's own, not an error page, not something that is only a download.
import type { WebContents } from 'electron'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import type { HistoryService } from './history-service.js'

/** The schemes a person could open again from a list. */
const RECORDED_SCHEMES = new Set(['http:', 'https:', 'ipfs:', 'ipns:'])

export interface HistoryHost {
  /** Whether `contents` is a tab showing a page that belongs in history. False for the new-tab page and the shell's own. */
  recordable: (contents: WebContents) => boolean
}

/** The address a visit is kept under, or null for one that is not kept. */
export function historyAddress (url: string): string | null {
  const shown = BUILTIN_ADDRESSES.displayUrl(url)
  try {
    return RECORDED_SCHEMES.has(new URL(shown).protocol) ? shown : null
  } catch {
    return null
  }
}

/** A page can change its own address as often as it likes, and each change is a row: one in a second is what a person
 * could have made by moving through it. */
const IN_PAGE_INTERVAL_MS = 1000

export function attachHistory (contents: WebContents, history: HistoryService, host: HistoryHost, now: () => number = Date.now): void {
  let lastInPage = -Infinity
  const visit = (url: string): void => {
    if (contents.isDestroyed() || !host.recordable(contents)) return
    const address = historyAddress(url)
    if (address !== null) history.visit(address, contents.getTitle())
  }
  contents.on('did-navigate', (_event, url, httpResponseCode) => {
    // An error page is not a page the person visited; 0 is a load with no response (a file, a cached page).
    if (httpResponseCode >= 400) return
    visit(url)
  })
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame || now() - lastInPage < IN_PAGE_INTERVAL_MS) return
    lastInPage = now()
    visit(url)
  })
  contents.on('page-title-updated', (_event, title) => {
    if (contents.isDestroyed() || !host.recordable(contents)) return
    const address = historyAddress(contents.getURL())
    if (address !== null) history.titled(address, title)
  })
}
