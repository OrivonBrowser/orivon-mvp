import type { ShellStatePart } from '../shell-state-parts.js'

/** Whether the page in front goes through the tunnel, for the colour of the address bar's tunnel button. */
export const tunnelStatePart: ShellStatePart = {
  name: 'tunnel',
  read: ({ window, services }, tabs) => {
    const wc = tabs.activeTabId === null ? undefined : window.tabs.liveWebContents(tabs.activeTabId)
    if (wc === undefined || tabs.activeTabId === null) return { tunnel: null }
    return { tunnel: services.tunnel.markOf(wc.getURL(), window.tabs.partitionOf(tabs.activeTabId)) }
  },
  watch: ({ services }, push) => services.tunnel.onChange(push)
}
