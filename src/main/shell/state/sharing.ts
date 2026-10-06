import { shareRegistry } from '../../display-capture/bindings.js'
import { onShareChange } from '../../display-capture/indicators/share-events.js'
import { newestShare } from '../../display-capture/indicators/shares.js'
import { formatOriginForDisplay } from '../../consent/grant-prompt-origin.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** What the page in front is sharing, for the sharing chip in the address bar; null when it shares nothing. */
export const sharingStatePart: ShellStatePart = {
  name: 'sharing',
  read: ({ window }, tabs) => {
    const wc = tabs.activeTabId === null ? undefined : window.tabs.liveWebContents(tabs.activeTabId)
    const shares = wc === undefined ? [] : shareRegistry().forRequester(wc)
    const latest = newestShare(shares)
    return { sharing: latest === undefined ? null : { kind: latest.kind, origin: formatOriginForDisplay(latest.origin), count: shares.length } }
  },
  watch: (_ctx, push) => onShareChange(push)
}
