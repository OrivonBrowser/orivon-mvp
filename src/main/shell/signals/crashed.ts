// A tab whose page process died or stopped answering. The death is kept on the tab's record, so the strip marks
// it and the window's sad-tab card can offer the way back; Chromium keeps the webContents, and a reload brings
// the page back in it. A tab in the background only gets the strip mark until the person goes to it.
import type { WebContentsView } from 'electron'
import { markResponsive, markUnresponsive, troubleOf } from '../../sad-tab/sad-tab-state.js'
import { syncSadTab, watchActivations } from '../../sad-tab/sad-tab-controller.js'
import { DEFAULT_BACKGROUND, INTERNAL_PAGE_BACKGROUND, resolveThemeColor } from '../theme-colors.js'
import type { TabSignal } from '../tab-signals.js'
import type { TabRecord } from '../tab-types.js'

/** Views painted dark because their page died, so the colour is put back only for those. */
const dimmed = new WeakSet<WebContentsView>()

/** A dead view paints nothing of its own, so it would show Electron's white behind the card in a dark theme. The
 * dashboard and the shell's own pages already carry their own colour; only an ordinary page is on the default. */
function dim (view: WebContentsView, record: TabRecord): void {
  if (record.isDashboardTab || record.internalPage !== null) return
  view.setBackgroundColor(resolveThemeColor(INTERNAL_PAGE_BACKGROUND))
  dimmed.add(view)
}

function undim (view: WebContentsView): void {
  if (dimmed.delete(view)) view.setBackgroundColor(DEFAULT_BACKGROUND)
}

export const crashedSignal: TabSignal = {
  name: 'crashed',
  wire: ({ record, view, wc, shown }) => {
    const { services } = record.host
    if (services !== undefined) watchActivations(services.tabLifecycle, (contents) => services.windows.findOwner(contents))
    const sync = (): void => {
      const owner = wc.isDestroyed() ? undefined : services?.windows.findOwner(wc)
      if (owner !== undefined) syncSadTab(owner)
    }
    /** The page answers again or loads another document: whatever the card was about is over. */
    const recovered = (): void => {
      if (troubleOf(record) === null) return
      record.crashed = null
      markResponsive(record)
      undim(view)
      record.host.emitState()
      sync()
    }

    wc.on('render-process-gone', (_event, details) => {
      if (wc.isDestroyed() || !shown() || details.reason === 'clean-exit') return
      record.crashed = details.reason
      markResponsive(record)
      dim(view, record)
      record.host.emitState()
      sync()
    })
    wc.on('did-navigate', () => { if (!wc.isDestroyed() && shown()) recovered() })
    wc.on('did-start-loading', () => { if (!wc.isDestroyed() && shown()) recovered() })
    wc.on('unresponsive', () => {
      if (wc.isDestroyed() || !shown() || (record.crashed !== undefined && record.crashed !== null)) return
      markUnresponsive(record)
      sync()
    })
    wc.on('responsive', () => {
      if (wc.isDestroyed() || !shown()) return
      markResponsive(record)
      sync()
    })
  }
}
