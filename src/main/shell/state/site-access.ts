import { pageAccess } from '../../site-settings/page-access.js'
import { siteKindById } from '../../site-settings/kinds.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** What the page in front was asked for and answered, for the chip in the address bar; it follows the record live. */
export const siteAccessStatePart: ShellStatePart = {
  name: 'siteAccess',
  read: ({ window }, tabs) => {
    const wc = tabs.activeTabId === null ? undefined : window.tabs.liveWebContents(tabs.activeTabId)
    const entries = wc === undefined ? [] : pageAccess.entries(wc)
    return { siteAccess: entries.map(({ kind, state }) => ({ kind, state, label: siteKindById(kind)?.label ?? kind })) }
  },
  watch: (_ctx, push) => pageAccess.onChange(push)
}
