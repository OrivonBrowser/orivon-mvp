import { siteContentBlocks } from '../../site-settings/site-content-blocks.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** Whether the page in front is on a site with JavaScript, images or sound switched off, for the mark on the address bar's key. */
export const contentBlockedStatePart: ShellStatePart = {
  name: 'contentBlocked',
  read: ({ window }, tabs) => {
    const wc = tabs.activeTabId === null ? undefined : window.tabs.liveWebContents(tabs.activeTabId)
    return { contentBlocked: wc !== undefined && !wc.isDestroyed() && siteContentBlocks.blocked(wc.getURL()) }
  },
  watch: (_ctx, push) => siteContentBlocks.onChange(push)
}
