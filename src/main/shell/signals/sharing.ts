// A tab's part in a screen share: whether it is the page being given a capture, and whether it is the tab being shown.
// The registry that knows lives in ../../display-capture/; this reads it per state push and asks for a push when a
// share starts or ends, for just the two tabs that share touches.
import type { WebContents } from 'electron'
import { shareRegistry } from '../../display-capture/bindings.js'
import { newestShare } from '../../display-capture/indicators/shares.js'
import { onShareChange } from '../../display-capture/indicators/share-events.js'
import type { ActiveShare, ShareRegistry } from '../../display-capture/types.js'
import type { TabSignal } from '../tab-signals.js'

/** The tabs' own request for a state push, by the webContents they show. */
const pushers = new Map<WebContents, () => void>()

export const sharingSignal: TabSignal = {
  name: 'sharing',
  wire: ({ wc, shown, record }) => {
    pushers.set(wc, () => { if (shown()) record.host.emitState() })
    wc.once('destroyed', () => { pushers.delete(wc) })
  },
  state: (_record, wc) => {
    if (wc === undefined) return {}
    const registry = shareRegistry()
    const sharing = newestShare(registry.forRequester(wc))
    return {
      ...(sharing === undefined ? {} : { sharing: sharing.kind }),
      ...(registry.forCaptured(wc).length > 0 ? { shared: true } : {})
    }
  }
}

/** Starts asking the tabs a share touches to push their state. Returns the stop. */
export function watchShares (registry: () => ShareRegistry = shareRegistry, onChange: (listener: () => void) => () => void = onShareChange): () => void {
  let known = new Map<string, ActiveShare>()
  return onChange(() => {
    const now = new Map(registry().list().map((share) => [share.id, share]))
    for (const [id, share] of [...now, ...known]) {
      if (now.has(id) === known.has(id)) continue
      pushers.get(share.requester)?.()
      if (share.captured !== undefined) pushers.get(share.captured)?.()
    }
    known = now
  })
}
