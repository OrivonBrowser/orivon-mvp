import type { ShellStatePart } from '../shell-state-parts.js'
import { tabForTunnelPopover } from '../tunnel-popover-tab.js'

/**
 * Whether the page in front goes through a tunnel, and which, for the colour of the address bar's tunnel button and the name it
 * carries. A new tab shows no page: its look is the tunnel its first address will leave by, from the tab's choice or the browser's.
 * A blank page in a tab that is not the dashboard's (a popup a page opened with no address) is no new tab: it has no look, as no page has one.
 * `tunnelByTab` says the button is about the tab, by the test that picks the list it opens, so the words it draws never promise a tab's setting the click does not open.
 */
export const tunnelStatePart: ShellStatePart = {
  name: 'tunnel',
  read: ({ window, services }, tabs) => {
    const tunnelByTab = tabForTunnelPopover(tabs, (id) => window.tabs.partitionOf(id), services.tunnel.isApp) !== undefined
    if (tabs.activeTabId === null) return { tunnel: null, tunnelVia: null, tunnelByTab }
    const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId)
    if (active?.isNewTab === true && active.blankPage !== true) {
      const look = services.tunnel.newTabLookOf(active.tunnelChoice)
      return { tunnel: look.mark, tunnelVia: look.via, tunnelByTab }
    }
    const wc = window.tabs.liveWebContents(tabs.activeTabId)
    if (wc === undefined) return { tunnel: null, tunnelVia: null, tunnelByTab }
    const look = services.tunnel.lookOf(wc.getURL(), window.tabs.partitionOf(tabs.activeTabId), active?.tunnelChoice)
    return { tunnel: look.mark, tunnelVia: look.via, tunnelByTab }
  },
  watch: ({ services }, push) => services.tunnel.onChange(push)
}
