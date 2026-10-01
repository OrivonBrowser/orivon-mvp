// Escape stops a page that is still loading. The key is not taken from the
// page: it reaches it as well, so a page that closes its own dialog on Escape
// still does.
import type { TabSignal } from '../tab-signals.js'

export const stopKeySignal: TabSignal = {
  name: 'stop-key',
  wire: ({ wc, shown }) => {
    wc.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || input.shift || input.control || input.alt || input.meta) return
      if (shown() && wc.isLoadingMainFrame()) wc.stop()
    })
  }
}
