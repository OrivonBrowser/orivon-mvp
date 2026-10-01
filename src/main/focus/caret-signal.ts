// Caret browsing is a setting of one web contents, so each tab's page is given it when the tab wires, and again
// when a view returns to the tab (a new origin swaps the view). The new-tab page is the one page that is left
// out, and it stops being that page on its first navigation, which is when the setting has to reach it.
import type { WebContents } from 'electron'
import type { TabSignal } from '../shell/tab-signals.js'
import type { TabRecord } from '../shell/tab-types.js'
import { caretAppliesTo, CARET_SETTING } from './caret.js'

function putOn (wc: WebContents, record: TabRecord): void {
  const settings = record.host.services?.settings
  if (settings === undefined || wc.isDestroyed()) return
  wc.setCaretBrowsingEnabled(settings.get(CARET_SETTING) === true && caretAppliesTo(record))
}

export const caretSignal: TabSignal = {
  name: 'caret',
  wire: ({ wc, record, shown }) => {
    // Registered after the tab's own navigation handler, which is the one that clears `isDashboardTab`.
    wc.on('did-navigate', () => { if (shown()) putOn(wc, record) })
  },
  apply: ({ wc, record }) => { putOn(wc, record) }
}
