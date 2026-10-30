// A tab's page says which link the pointer or the keyboard is on (Electron's `update-target-url`), and that it has
// left the page (a navigation, a crash, closing): both go to the window's bubble. The window's bubble is made by the
// first link only, so a window nobody points a link in is as it was.
import type { WebContents } from 'electron'
import type { TabSignal } from '../shell/tab-signals.js'
import { existingLinkStatus, linkStatusFor } from './link-status-for.js'
import type { LinkStatus } from './link-status.js'

/** The bubble each page last spoke to: a destroyed page can no longer be traced back to its window. */
const spoken = new WeakMap<WebContents, LinkStatus>()

export const linkStatusSignal: TabSignal = {
  name: 'link-status',
  wire: ({ id, wc, record, view, shown }) => {
    const tab = { id, pane: () => record.host.isShown(id) && !wc.isDestroyed() ? view.getBounds() : undefined }
    wc.on('update-target-url', (_event, url) => {
      if (!shown()) return
      const owner = record.host.services?.windows.findOwner(wc)
      if (owner === undefined) return
      const status = url === '' ? existingLinkStatus(owner) : linkStatusFor(owner)
      if (status === undefined) return
      spoken.set(wc, status)
      status.hovered(tab, url)
    })
    const left = (): void => { spoken.get(wc)?.left(id) }
    wc.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) left() })
    wc.on('render-process-gone', left)
    wc.once('destroyed', left)
  }
}
