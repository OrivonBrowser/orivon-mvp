// What a tab's view paints behind a sheet that sits over it. A failed load leaves an error page with no
// background of its own, so the sheet would float on whatever the view last held: Electron's white, or the
// new-tab page's own colour. While a sheet is up the view carries the shell's own surface colour for the
// current theme; when the sheet goes the view gets back what it had. Tied to Electron: a view's colour.
import type { WebContents, WebContentsView } from 'electron'
import type { SheetBackdrop } from '../overlays/tab-slots.js'
import type { TabRecord } from './tab-types.js'
import { DASHBOARD_BACKGROUND, DEFAULT_BACKGROUND, INTERNAL_PAGE_BACKGROUND, onThemeUpdated, resolveThemeColor } from './theme-colors.js'
import { recordViewBackground } from './view-background-test-hook.js'

/** Views that carry the sheet colour now. */
const raised = new Set<WebContentsView>()
let followingTheme = false

const sheetColor = (): string => resolveThemeColor(INTERNAL_PAGE_BACKGROUND)

/** The colour a view must keep while a sheet is over it, or undefined: a reset made by a navigation asks first. */
export function sheetBackdropOf (view: WebContentsView): string | undefined {
  return raised.has(view) ? sheetColor() : undefined
}

function paint (view: WebContentsView, color: string): void {
  const wc: WebContents | undefined = view.webContents
  if (wc === undefined || wc.isDestroyed()) return
  view.setBackgroundColor(color)
  recordViewBackground(wc.id, color)
}

const withoutQuery = (url: string): string => url.split(/[?#]/)[0] ?? url

/** Whether `url` is the new-tab page itself, in the dev server's form and in the built file's. */
export function isDashboardUrl (url: string, dashboardUrl: string): boolean {
  return withoutQuery(url) === withoutQuery(dashboardUrl)
}

/** What the view holds when no sheet is over it: the dashboard's colour while it shows the dashboard, an internal
 * page's surface, or the default. Read from the URL the view shows, so a tab that came back to the dashboard
 * has it again; a page can only choose between that colour and the default this way. Also what the window
 * behind the views shows for the tab on top. */
export function restingColor (record: TabRecord): string {
  // A page's own event can land while its view is torn down and has no webContents at all: no address, so not the dashboard.
  const wc: WebContents | undefined = record.view.webContents
  const address = wc === undefined || wc.isDestroyed() ? null : wc.getURL()
  // A dashboard tab is shown before its load starts and has no address yet: it already holds the dashboard's colour.
  if (address !== null && (isDashboardUrl(address, record.host.dashboardUrl) || (address === '' && record.isDashboardTab))) return resolveThemeColor(DASHBOARD_BACKGROUND)
  return record.internalPage !== null ? sheetColor() : DEFAULT_BACKGROUND
}

/** One listener for the process: a light sheet must not sit on a dark backdrop after the theme changes. */
function followTheme (): void {
  if (followingTheme) return
  followingTheme = true
  onThemeUpdated(() => { for (const view of raised) paint(view, sheetColor()) })
}

export const sheetBackdrop: SheetBackdrop = {
  raise (window, tabId) {
    const view = window.tabs.record(tabId)?.view
    if (view === undefined) return
    if (!raised.has(view)) view.webContents.once('destroyed', () => { raised.delete(view) })
    raised.add(view)
    followTheme()
    paint(view, sheetColor())
  },
  lower (window, tabId) {
    const record = window.tabs.record(tabId)
    if (record === undefined || !raised.delete(record.view)) return
    paint(record.view, restingColor(record))
  }
}
