// Tied to Electron through the events of the `WebContents` it wires.
import type { WebContents } from 'electron'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { isNavigationHeld } from './navigation-hold.js'

/** Chromium knows no `ipfs:` scheme and would offer a link to one to the OS; it loads here instead, from the URL its protocol serves it at. */
export function loadServedAddresses (wc: WebContents, isInternalPage: () => boolean): void {
  wc.on('will-navigate', (event) => {
    if (isInternalPage()) return
    const served = BUILTIN_ADDRESSES.servedUrl(event.url)
    if (served === undefined) return
    // A prevented event does not stop this listener, and a load from here is
    // one the hold never sees.
    const refused = event.defaultPrevented || isNavigationHeld(wc)
    event.preventDefault()
    if (refused) return
    void wc.loadURL(served)
  })
}
