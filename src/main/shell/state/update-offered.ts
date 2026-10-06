import { originFromUrl } from '../../../broker/policy/origin.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** Whether the page in front is an installed app whose name now points at a version the person has not taken, for the dot on the address bar's key. */
export const updateOfferedStatePart: ShellStatePart = {
  name: 'updateOffered',
  read: ({ window, services }, tabs) => {
    const wc = tabs.activeTabId === null ? undefined : window.tabs.liveWebContents(tabs.activeTabId)
    const origin = wc === undefined || wc.isDestroyed() ? null : originFromUrl(wc.getURL())
    return { updateOffered: origin !== null && services.updateOffers.pending(origin) !== undefined }
  },
  watch: ({ services }, push) => services.updateOffers.onChange(push)
}
