import type { WebContents } from 'electron'
import type { TabRecord } from './tab-types.js'

/** Keeps `record.inflightUrl` at the address the main frame is loading and has not yet committed. A reload during
 * that load restarts it (tab-navigation.ts's reloadTab), and `wc.reload()` alone would reload the page already shown.
 * `shown` is false while the view is swapped out or parked, whose navigations are not the tab's. */
export function trackInflightUrl (wc: WebContents, record: Pick<TabRecord, 'inflightUrl'>, shown: () => boolean): void {
  const clear = (): void => { delete record.inflightUrl }
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && shown()) record.inflightUrl = details.url
  })
  wc.on('did-navigate', clear)
  wc.on('did-stop-loading', clear)
  wc.on('did-finish-load', clear)
  wc.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame) clear() })
}
