// What makes a tab showing an internal page different from any other tab: it
// stays on its own page. Nothing it links to, opens or is redirected to loads
// in the internal session; a website it points at opens in an ordinary tab.
import type { WebContentsView } from 'electron'
import { sanitizeDirectUrl } from '../browsing/omnibox.js'
import { parseInternalUrl } from './internal-pages.js'
import type { InternalPageId } from './internal-pages.js'

/** `openTab` opens a URL in an ordinary tab of the same window. */
export function guardInternalView (view: WebContentsView, page: InternalPageId, openTab: (url: string) => void): void {
  const { webContents } = view
  const openElsewhere = (url: string): void => {
    const openable = sanitizeDirectUrl(url)
    if (openable !== null) openTab(openable)
  }
  // Never a popup: one Chromium creates keeps its opener's session, which
  // would put a website in the internal session with a handle to this page.
  webContents.setWindowOpenHandler(({ url }) => {
    openElsewhere(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event) => {
    if (parseInternalUrl(event.url)?.page === page) return
    event.preventDefault()
    openElsewhere(event.url)
  })
}
