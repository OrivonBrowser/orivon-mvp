import type { WebContents } from 'electron'
import type { TabRecord } from './tab-types.js'

/** Keeps `record.inflightUrl` at the address the main frame is loading and has not yet committed. A reload during
 * that load restarts it (tab-navigation.ts's reloadTab), and `wc.reload()` alone would reload the page already shown.
 * `shown` is false while the view is swapped out or parked, whose navigations are not the tab's.
 *
 * Only the navigation's own end clears it: a commit, a stop, or a failure at one of its addresses (the first, or
 * where a redirect led). `did-finish-load` is no end, since the page being left fires it for its own onload while
 * the new navigation is still pending; and a failure at another address belongs to the navigation this one
 * replaced. A navigation cancelled before it commits (`will-navigate`, a download) reports its abort as a
 * provisional failure. */
export function trackInflightUrl (wc: WebContents, record: Pick<TabRecord, 'inflightUrl'>, shown: () => boolean): void {
  const addresses = new Set<string>()
  const clear = (): void => {
    delete record.inflightUrl
    addresses.clear()
  }
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument || !shown()) return
    addresses.clear()
    addresses.add(details.url)
    record.inflightUrl = details.url
  })
  wc.on('did-redirect-navigation', (details) => {
    if (details.isMainFrame && record.inflightUrl !== undefined) addresses.add(details.url)
  })
  wc.on('did-navigate', clear)
  wc.on('did-stop-loading', clear)
  const failed = (_event: unknown, _code: number, _description: string, url: string, isMainFrame: boolean): void => {
    if (isMainFrame && addresses.has(url)) clear()
  }
  wc.on('did-fail-provisional-load', failed)
  wc.on('did-fail-load', failed)
}
