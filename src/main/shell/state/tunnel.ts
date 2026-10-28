import type { ShellStatePart } from '../shell-state-parts.js'

/**
 * Whether the page in front goes through a tunnel, and which, for the colour of the address bar's tunnel button and the name it
 * carries. A new tab shows no page: its look is the tunnel its first address will leave by, from the tab's choice or the browser's.
 */
export const tunnelStatePart: ShellStatePart = {
  name: 'tunnel',
  read: ({ window, services }, tabs) => {
    if (tabs.activeTabId === null) return { tunnel: null, tunnelVia: null }
    const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId)
    if (active?.isNewTab === true) {
      const look = services.tunnel.newTabLookOf(active.tunnelChoice)
      return { tunnel: look.mark, tunnelVia: look.via }
    }
    const wc = window.tabs.liveWebContents(tabs.activeTabId)
    if (wc === undefined) return { tunnel: null, tunnelVia: null }
    const look = services.tunnel.lookOf(wc.getURL(), window.tabs.partitionOf(tabs.activeTabId), active?.tunnelChoice)
    return { tunnel: look.mark, tunnelVia: look.via }
  },
  watch: ({ services }, push) => services.tunnel.onChange(push)
}
