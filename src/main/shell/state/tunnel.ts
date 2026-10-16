import type { ShellStatePart } from '../shell-state-parts.js'

/** Whether the page in front goes through a tunnel, and which, for the colour of the address bar's tunnel button and the name it carries. */
export const tunnelStatePart: ShellStatePart = {
  name: 'tunnel',
  read: ({ window, services }, tabs) => {
    const wc = tabs.activeTabId === null ? undefined : window.tabs.liveWebContents(tabs.activeTabId)
    if (wc === undefined || tabs.activeTabId === null) return { tunnel: null, tunnelVia: null }
    const look = services.tunnel.lookOf(wc.getURL(), window.tabs.partitionOf(tabs.activeTabId))
    return { tunnel: look.mark, tunnelVia: look.via }
  },
  watch: ({ services }, push) => services.tunnel.onChange(push)
}
