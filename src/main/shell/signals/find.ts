// A tab's own find events, handed to the window's find bar: the answer to a
// search, and the page loading another document under an open bar. Escape in
// the page closes the bar the way the bar's own Escape does.
import { findWindowFor, FIND_OVERLAY } from '../../find/find-window.js'
import type { TabSignal } from '../tab-signals.js'

export const findSignal: TabSignal = {
  name: 'find',
  wire: ({ wc, record, shown }) => {
    const barFor = (): ReturnType<typeof findWindowFor> => {
      if (!shown()) return undefined
      const owner = record.host.services?.windows.findOwner(wc)
      return owner === undefined ? undefined : findWindowFor(owner)
    }
    wc.on('found-in-page', (_event, found) => { barFor()?.result(wc, found) })
    // The loading events are the spinner's, raised for a frame's load too: only a new document in the tab itself
    // restarts the search, so an ad or a player reloading in a frame does not send the bar back to the first match.
    let documentLoading = false
    wc.on('did-start-loading', () => {
      const bar = barFor()
      if (bar === undefined || !wc.isLoadingMainFrame()) return
      documentLoading = true
      bar.loading(wc, 'start')
    })
    wc.on('did-stop-loading', () => {
      if (!documentLoading) return
      documentLoading = false
      barFor()?.loading(wc, 'stop')
    })
    wc.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || input.shift || input.control || input.alt || input.meta) return
      if (!shown()) return
      const owner = record.host.services?.windows.findOwner(wc)
      if (owner?.overlays.isOpen(FIND_OVERLAY) === true && owner.tabs.activeWebContents() === wc) owner.overlays.close(FIND_OVERLAY)
    })
  }
}
