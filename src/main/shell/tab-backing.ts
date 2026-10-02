// What a tab's view paints before its page has: the colour is chosen when a navigation STARTS, because the
// old document covers the view until the new one commits and a colour set after the commit lands on the frame
// the new page has not painted yet. Tied to Electron: a view's colour.
import type { WebContents, WebContentsView } from 'electron'
import type { TabRecord } from './tab-types.js'
import { isDashboardUrl, sheetBackdropOf } from './sheet-backdrop.js'
import { APP_DARK_WASH, DEFAULT_BACKGROUND } from './theme-colors.js'
import { recordViewBackground } from './view-background-test-hook.js'

/** Paints a view and records the colour for the e2e hook. A view torn down has no webContents, and gets nothing. */
export function paintBacking (view: WebContentsView, color: string): void {
  const wc: WebContents | undefined = view.webContents
  if (wc === undefined || wc.isDestroyed()) return
  view.setBackgroundColor(color)
  recordViewBackground(wc.id, color)
}

/** Follows the page a tab is going to: the dashboard's wash only for the dashboard, the default for everything
 * else, whichever the tab held before. An internal page never leaves its page, and a sheet over the view keeps
 * its own surface until it goes. */
export function watchBacking (view: WebContentsView, record: TabRecord, shown: () => boolean): void {
  const wc = view.webContents
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument || !shown()) return
    if (record.internalPage !== null || sheetBackdropOf(view) !== undefined) return
    paintBacking(view, isDashboardUrl(details.url, record.host.dashboardUrl) ? APP_DARK_WASH : DEFAULT_BACKGROUND)
  })
  // A navigation that never commits (a download, a 204) leaves the old document: the colour it was painted for comes back.
  wc.on('did-stop-loading', () => {
    if (!shown() || !isDashboardUrl(wc.getURL(), record.host.dashboardUrl) || sheetBackdropOf(view) !== undefined) return
    paintBacking(view, APP_DARK_WASH)
  })
}
