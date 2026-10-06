// Tied to Electron through the events of the `WebContents` it wires.
import type { WebContents } from 'electron'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { isNavigationHeld } from './navigation-hold.js'

/** What opens a link to an ENS gateway address as the `.eth` name it stands for (./eth-gateway-redirect.ts). */
export interface GatewayLinks {
  /** The address to open instead, or undefined to leave the link alone. */
  readonly target: (url: string) => string | undefined
  /** Opens that address in this tab; the tab's own partition rules apply to it. */
  readonly open: (url: string) => void
}

/** Chromium knows no `ipfs:` scheme and would offer a link to one to the OS; it loads here instead, from the URL its protocol serves it at. A gateway link is replaced the same way. */
export function loadServedAddresses (wc: WebContents, isInternalPage: () => boolean, gateway?: GatewayLinks): void {
  wc.on('will-navigate', (event) => {
    if (isInternalPage()) return
    const served = BUILTIN_ADDRESSES.servedUrl(event.url)
    const replacement = served === undefined ? gateway?.target(event.url) : undefined
    if (served === undefined && replacement === undefined) return
    // A prevented event does not stop this listener, and a load from here is
    // one the hold never sees.
    const refused = event.defaultPrevented || isNavigationHeld(wc)
    event.preventDefault()
    if (refused) return
    if (served !== undefined) void wc.loadURL(served)
    else if (replacement !== undefined) gateway?.open(replacement)
  })
}
