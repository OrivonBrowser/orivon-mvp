import { popupBlocks } from '../../site-settings/site-popups.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** How many windows the page in front tried to open and was refused, for the pop-up chip in the address bar. */
export const popupsBlockedStatePart: ShellStatePart = {
  name: 'popupsBlocked',
  read: ({ window }, tabs) => {
    const wc = tabs.activeTabId === null ? undefined : window.tabs.liveWebContents(tabs.activeTabId)
    return { popupsBlocked: wc === undefined ? 0 : popupBlocks.count(wc) }
  },
  watch: (_ctx, push) => popupBlocks.onChange(push)
}
