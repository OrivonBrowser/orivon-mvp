// A sleeping tab's state in the chrome. Its view is blank, so what the strip, the address bar and Back and Forward
// show is read from what the tab kept. A navigation of the tab's page ends the sleep: whatever loads is the page now.
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import type { TabSignal } from '../shell/tab-signals.js'
import { clearMediaInUse } from './media-in-use.js'

export const sleepSignal: TabSignal = {
  name: 'sleep',
  wire: ({ wc, record, shown }) => {
    wc.on('did-start-navigation', (details) => {
      if (!shown() || !details.isMainFrame || details.isSameDocument) return
      clearMediaInUse(wc)
      if (record.sleeping == null) return
      record.sleeping = null
      record.host.emitState()
    })
  },
  state: (record) => {
    const kept = record.sleeping
    if (kept == null) return { sleeping: false }
    return {
      sleeping: true,
      url: kept.url,
      displayUrl: BUILTIN_ADDRESSES.displayUrl(kept.url),
      title: kept.title,
      favicon: kept.favicon,
      canGoBack: kept.index > 0,
      canGoForward: kept.index < kept.entries.length - 1,
      loading: false
    }
  }
}
